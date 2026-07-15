import {lstat, readFile, realpath} from 'node:fs/promises'
import path from 'node:path'

export const API_ORIGIN = 'https://publish.miyaip.com'

const MAX_ARTICLE_BYTES = 2 * 1024 * 1024
const MAX_ASSET_BYTES = 20 * 1024 * 1024
const MAX_ASSETS = 10
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MULTIPART_OVERHEAD_BUDGET = 64 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 180_000
const SAFE_ASSET_PATH = /^\.\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u
const SAFE_RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const SAFE_ASSET_ID = /^image-[A-Za-z0-9]+-[0-9]+x[0-9]+-[A-Za-z0-9]+$/u
const PROJECT_ID_PATTERN = /^[a-z0-9]{1,64}$/u
const DATASET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
const API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const SNAPSHOT_BRAND = Symbol('article-request-snapshot')

const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

class ClientError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ClientError'
    this.code = code
  }
}

export class PublisherApiError extends Error {
  constructor({statusCode = 0, code, requestId, uploadedAssetIds = []}) {
    super(statusCode ? `发布 API 请求失败（${statusCode}/${code}）。` : '发布结果不确定，请勿自动重试。')
    this.name = 'PublisherApiError'
    this.statusCode = statusCode
    this.code = code
    this.requestId = requestId
    this.uploadedAssetIds = uploadedAssetIds
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function hasImageSignature(bytes, extension) {
  if (extension === '.png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (extension === '.gif') {
    const signature = bytes.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  if (extension === '.webp') {
    return (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }
  if (extension === '.avif') {
    const box = bytes.subarray(0, 32).toString('ascii')
    return box.slice(4, 8) === 'ftyp' && /avif|avis/u.test(box.slice(8))
  }
  return false
}

function collectLocalAssetPaths(article) {
  const sources = []
  if (article?.coverImage?.source) sources.push(article.coverImage.source)
  for (const locale of ['en', 'zh']) {
    if (!Array.isArray(article?.body?.[locale])) continue
    for (const item of article.body[locale]) {
      if (item?._type === 'image' && item.source) sources.push(item.source)
    }
  }

  const paths = new Set()
  for (const source of sources) {
    if (!source || typeof source !== 'object' || !('path' in source)) continue
    if (typeof source.path !== 'string' || !SAFE_ASSET_PATH.test(source.path)) {
      throw new ClientError('ASSET_PATH_INVALID', '本地图片路径必须是 ./assets/<安全文件名>。')
    }
    paths.add(source.path)
  }
  if (paths.size > MAX_ASSETS) {
    throw new ClientError('ASSET_COUNT_EXCEEDED', '文章最多只能引用 10 张本地图片。')
  }
  return [...paths]
}

async function inspectArticleFile(articlePath, blogRoot) {
  let resolvedBlogRoot
  let resolvedArticle
  let info
  try {
    resolvedBlogRoot = await realpath(path.resolve(blogRoot))
    const requested = path.resolve(articlePath)
    info = await lstat(requested)
    if (!info.isFile() || info.isSymbolicLink() || path.extname(requested).toLowerCase() !== '.json') {
      throw new Error('invalid article')
    }
    resolvedArticle = await realpath(requested)
  } catch {
    throw new ClientError('ARTICLE_INVALID', '文章 JSON 不存在或不是普通文件。')
  }
  if (!isInside(resolvedBlogRoot, resolvedArticle)) {
    throw new ClientError('ARTICLE_LOCATION_INVALID', '文章 JSON 必须位于固定 blog 目录。')
  }
  if (info.size <= 0 || info.size > MAX_ARTICLE_BYTES) {
    throw new ClientError('ARTICLE_SIZE_INVALID', '文章 JSON 大小必须在 2 MiB 以内。')
  }

  const bytes = await readFile(resolvedArticle)
  if (bytes.length <= 0 || bytes.length > MAX_ARTICLE_BYTES) {
    throw new ClientError('ARTICLE_SIZE_INVALID', 'Article JSON must be no larger than 2 MiB.')
  }
  let article
  try {
    article = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ClientError('ARTICLE_JSON_INVALID', '文章 JSON 无法解析。')
  }
  if (
    !article ||
    typeof article !== 'object' ||
    typeof article.slug !== 'string' ||
    path.basename(resolvedArticle, '.json') !== article.slug
  ) {
    throw new ClientError('ARTICLE_SLUG_MISMATCH', 'JSON slug 必须与文件名一致。')
  }
  return {article, articleBytes: bytes, articlePath: resolvedArticle, blogRoot: resolvedBlogRoot}
}

async function inspectAssets(articleInfo) {
  const assetRoot = path.join(path.dirname(articleInfo.articlePath), 'assets')
  const localPaths = collectLocalAssetPaths(articleInfo.article)
  const assets = []
  let total =
    articleInfo.articleBytes.length + (localPaths.length > 0 ? MULTIPART_OVERHEAD_BUDGET : 0)

  for (const relativePath of localPaths) {
    const filename = relativePath.slice('./assets/'.length)
    const candidate = path.join(assetRoot, filename)
    let info
    let resolved
    try {
      info = await lstat(candidate)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid asset')
      resolved = await realpath(candidate)
    } catch {
      throw new ClientError('ASSET_FILE_INVALID', '引用的本地图片不存在或不是普通文件。')
    }
    if (!isInside(assetRoot, resolved)) {
      throw new ClientError('ASSET_PATH_INVALID', '本地图片超出 assets 目录。')
    }
    if (info.size <= 0 || info.size > MAX_ASSET_BYTES) {
      throw new ClientError('ASSET_SIZE_INVALID', '单张本地图片必须在 20 MiB 以内。')
    }
    const extension = path.extname(filename).toLowerCase()
    const mimeType = MIME_TYPES.get(extension)
    if (!mimeType) throw new ClientError('ASSET_FORMAT_INVALID', '本地图片格式不受支持。')
    const bytes = await readFile(resolved)
    if (bytes.length <= 0 || bytes.length > MAX_ASSET_BYTES) {
      throw new ClientError('ASSET_SIZE_INVALID', 'Each local image must be no larger than 20 MiB.')
    }
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) {
      throw new ClientError('REQUEST_SIZE_EXCEEDED', 'Article and image request exceeds 64 MiB.')
    }
    if (!hasImageSignature(bytes, extension)) {
      throw new ClientError('ASSET_FORMAT_INVALID', '图片内容与扩展名不匹配。')
    }
    assets.push({filename, mimeType, bytes, path: resolved})
  }
  return assets
}

export async function buildArticleRequest(articlePath, {blogRoot} = {}) {
  if (!blogRoot) throw new ClientError('BLOG_DIRECTORY_REQUIRED', '缺少固定 blog 目录。')
  const articleInfo = await inspectArticleFile(articlePath, blogRoot)
  const localAssets = await inspectAssets(articleInfo)
  if (localAssets.length === 0) {
    return {
      article: articleInfo.article,
      body: articleInfo.articleBytes,
      headers: {'Content-Type': 'application/json'},
      localAssets,
    }
  }

  const body = new FormData()
  body.append(
    'article',
    new Blob([articleInfo.articleBytes], {type: 'application/json'}),
    path.basename(articleInfo.articlePath),
  )
  for (const asset of localAssets) {
    body.append('assets', new Blob([asset.bytes], {type: asset.mimeType}), asset.filename)
  }
  return {article: articleInfo.article, body, headers: {}, localAssets}
}

export async function prepareArticleSnapshot(articlePath, {blogRoot} = {}) {
  if (!blogRoot) throw new ClientError('BLOG_DIRECTORY_REQUIRED', 'A fixed blog directory is required.')
  const articleInfo = await inspectArticleFile(articlePath, blogRoot)
  const localAssets = await inspectAssets(articleInfo)
  return Object.freeze({
    [SNAPSHOT_BRAND]: true,
    article: articleInfo.article,
    articleBytes: Buffer.from(articleInfo.articleBytes),
    articlePath: articleInfo.articlePath,
    localAssets: Object.freeze(
      localAssets.map((asset) => Object.freeze({...asset, bytes: Buffer.from(asset.bytes)})),
    ),
  })
}

function materializeArticleSnapshot(snapshot) {
  if (!snapshot || snapshot[SNAPSHOT_BRAND] !== true) {
    throw new ClientError('ARTICLE_SNAPSHOT_INVALID', 'Article request snapshot is invalid.')
  }
  if (snapshot.localAssets.length === 0) {
    return {
      article: snapshot.article,
      body: Buffer.from(snapshot.articleBytes),
      headers: {'Content-Type': 'application/json'},
      localAssets: snapshot.localAssets,
    }
  }

  const body = new FormData()
  body.append(
    'article',
    new Blob([snapshot.articleBytes], {type: 'application/json'}),
    path.basename(snapshot.articlePath),
  )
  for (const asset of snapshot.localAssets) {
    body.append('assets', new Blob([asset.bytes], {type: asset.mimeType}), asset.filename)
  }
  return {article: snapshot.article, body, headers: {}, localAssets: snapshot.localAssets}
}

function endpoint(operation) {
  if (operation === 'validate') return `${API_ORIGIN}/v1/blog-post-validations`
  if (operation === 'dry-run') return `${API_ORIGIN}/v1/blog-posts?dryRun=true`
  if (operation === 'create') return `${API_ORIGIN}/v1/blog-posts`
  throw new ClientError('OPERATION_INVALID', '只允许 validate、dry-run 或 create。')
}

function validateToken(token) {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 4096 ||
    token.trim() !== token ||
    /[\r\n\0]/u.test(token)
  ) {
    throw new ClientError('TOKEN_FORMAT_INVALID', 'Token 文件格式无效。')
  }
}

function isStrictCalendarDate(value) {
  if (!API_VERSION_PATTERN.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function validatePublishingConfig(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    !PROJECT_ID_PATTERN.test(config.projectId) ||
    !DATASET_PATTERN.test(config.dataset) ||
    !isStrictCalendarDate(config.apiVersion)
  ) {
    throw new ClientError('SANITY_TARGET_INVALID', 'Sanity target configuration is invalid.')
  }
  validateToken(config.sanityToken)
  return {
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    sanityToken: config.sanityToken,
  }
}

function matchesTarget(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    value.projectId === expected.projectId &&
    value.dataset === expected.dataset &&
    value.apiVersion === expected.apiVersion
  )
}

function doesNotContainSecret(value, token) {
  return typeof token !== 'string' || token.length === 0 || !value.includes(token)
}

function validRequestId(value, token) {
  return (
    typeof value === 'string' &&
    SAFE_REQUEST_ID.test(value) &&
    doesNotContainSecret(value, token)
  )
}

function validResultId(value, token) {
  return (
    typeof value === 'string' &&
    SAFE_RESULT_ID.test(value) &&
    doesNotContainSecret(value, token)
  )
}

function validUploadedAssetIds(ids, token) {
  return (
    Array.isArray(ids) &&
    ids.length <= MAX_ASSETS &&
    ids.every(
      (id) =>
        typeof id === 'string' &&
        SAFE_ASSET_ID.test(id) &&
        doesNotContainSecret(id, token),
    )
  )
}

function sanitizeSuccessEnvelope(operation, payload, expectedSlug, token, expectedTarget) {
  if (!payload || typeof payload !== 'object' || !validRequestId(payload.requestId, token)) {
    return undefined
  }
  const data = payload.data
  if (!data || typeof data !== 'object' || data.slug !== expectedSlug) return undefined
  if (expectedTarget && !matchesTarget(data.target, expectedTarget)) return undefined

  if (operation === 'validate') {
    if (
      data.valid !== true ||
      !data.bodyBlocks ||
      !Number.isInteger(data.bodyBlocks.en) ||
      data.bodyBlocks.en < 1 ||
      !Number.isInteger(data.bodyBlocks.zh) ||
      data.bodyBlocks.zh < 1 ||
      !Number.isInteger(data.localImageCount) ||
      data.localImageCount < 0 ||
      data.localImageCount > MAX_ASSETS
    ) {
      return undefined
    }
    return {
      data: {
        valid: true,
        slug: expectedSlug,
        bodyBlocks: {en: data.bodyBlocks.en, zh: data.bodyBlocks.zh},
        localImageCount: data.localImageCount,
      },
      requestId: payload.requestId,
    }
  }

  if (!validUploadedAssetIds(data.uploadedAssetIds, token)) return undefined
  if (operation === 'dry-run') {
    if (data.status !== 'dry-run' || data.mode !== 'create') return undefined
    return {
      data: {
        status: 'dry-run',
        mode: 'create',
        slug: expectedSlug,
        uploadedAssetIds: [...data.uploadedAssetIds],
        ...(expectedTarget ? {target: {...expectedTarget}} : {}),
      },
      requestId: payload.requestId,
    }
  }

  if (
    data.status !== 'published' ||
    data.mode !== 'created' ||
    !validResultId(data.id, token) ||
    !validResultId(data.revision, token)
  ) {
    return undefined
  }
  return {
    data: {
      status: 'published',
      mode: 'created',
      id: data.id,
      revision: data.revision,
      slug: expectedSlug,
      uploadedAssetIds: [...data.uploadedAssetIds],
      ...(expectedTarget ? {target: {...expectedTarget}} : {}),
    },
    requestId: payload.requestId,
  }
}

function safeErrorCode(value, token) {
  return typeof value === 'string' && SAFE_ERROR_CODE.test(value) && doesNotContainSecret(value, token)
    ? value
    : 'API_REQUEST_FAILED'
}

function safeUploadedAssetIds(payload, token) {
  const ids = payload?.error?.details?.uploadedAssetIds
  if (!Array.isArray(ids)) return []
  return ids
    .filter(
      (id) =>
        typeof id === 'string' &&
        SAFE_ASSET_ID.test(id) &&
        doesNotContainSecret(id, token),
    )
    .slice(0, MAX_ASSETS)
}

async function readLimitedResponse(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new PublisherApiError({statusCode: response.status, code: 'API_RESPONSE_INVALID'})
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new PublisherApiError({
          statusCode: response.status,
          code: 'API_RESPONSE_INVALID',
        })
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof PublisherApiError) throw error
    throw new PublisherApiError({statusCode: response.status, code: 'API_RESPONSE_INVALID'})
  }
  if (total === 0) {
    throw new PublisherApiError({statusCode: response.status, code: 'API_RESPONSE_INVALID'})
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function parseResponse(response) {
  const text = await readLimitedResponse(response)
  try {
    return JSON.parse(text)
  } catch {
    throw new PublisherApiError({statusCode: response.status, code: 'API_RESPONSE_INVALID'})
  }
}

export async function requestArticle(
  operation,
  articlePath,
  {
    blogRoot,
    token,
    publishingConfig,
    snapshot,
    fetchImpl = globalThis.fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {},
) {
  const url = endpoint(operation)
  if (typeof fetchImpl !== 'function') throw new ClientError('FETCH_UNAVAILABLE', '当前 Node 无 fetch。')
  const request = snapshot
    ? materializeArticleSnapshot(snapshot)
    : await buildArticleRequest(articlePath, {blogRoot})
  const headers = {...request.headers}
  let expectedTarget
  if (operation !== 'validate') {
    if (publishingConfig !== undefined) {
      const config = validatePublishingConfig(publishingConfig)
      token = config.sanityToken
      expectedTarget = {
        projectId: config.projectId,
        dataset: config.dataset,
        apiVersion: config.apiVersion,
      }
      headers['X-Sanity-Project-Id'] = config.projectId
      headers['X-Sanity-Dataset'] = config.dataset
      headers['X-Sanity-Api-Version'] = config.apiVersion
      headers['X-Sanity-Token'] = config.sanityToken
    } else {
      validateToken(token)
      headers['X-Sanity-Token'] = token
    }
  }

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new PublisherApiError({
      code: operation === 'create' ? 'NETWORK_RESULT_UNKNOWN' : 'NETWORK_REQUEST_FAILED',
    })
  }

  const payload = await parseResponse(response)
  if (!response.ok) {
    const code = safeErrorCode(payload?.error?.code, token)
    throw new PublisherApiError({
      statusCode: response.status,
      code,
      requestId: validRequestId(payload?.requestId, token) ? payload.requestId : undefined,
      uploadedAssetIds: safeUploadedAssetIds(payload, token),
    })
  }

  const expectedStatus = operation === 'create' ? 201 : 200
  const sanitized = sanitizeSuccessEnvelope(
    operation,
    payload,
    request.article.slug,
    token,
    expectedTarget,
  )
  if (response.status !== expectedStatus || !sanitized) {
    throw new PublisherApiError({
      statusCode: response.status,
      code: 'API_RESPONSE_INVALID',
      requestId: validRequestId(payload?.requestId, token) ? payload.requestId : undefined,
    })
  }
  return sanitized
}
