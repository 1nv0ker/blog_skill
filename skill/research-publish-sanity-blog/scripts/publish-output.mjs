#!/usr/bin/env node

import {lstat, readFile, realpath} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {PublisherApiError, prepareArticleSnapshot, requestArticle} from './api-client.mjs'
import {loadPublishingConfig} from './config.mjs'
import {validateOutput} from './validate-output.mjs'
import {WORKSPACE_ROOT, verifyWorkspace} from './workspace.mjs'

class ArgumentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArgumentError'
    this.code = 'ARGUMENT_INVALID'
  }
}

class PublishingBundleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublishingBundleError'
    this.code = code
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

async function readFinalMarkdown(markdownPath) {
  let info
  let resolved
  try {
    info = await lstat(markdownPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 2 * 1024 * 1024) {
      throw new Error('invalid markdown')
    }
    resolved = await realpath(markdownPath)
  } catch {
    throw new PublishingBundleError(
      'FINAL_MARKDOWN_REQUIRED',
      'The final bilingual Markdown file is missing or unsafe.',
    )
  }
  if (resolved !== path.resolve(markdownPath)) {
    throw new PublishingBundleError(
      'FINAL_MARKDOWN_REQUIRED',
      'The final bilingual Markdown file is missing or unsafe.',
    )
  }
  const markdown = await readFile(resolved, 'utf8')
  if (
    !/^# English$/mu.test(markdown) ||
    !/^# 中文$/mu.test(markdown) ||
    !/^## Sources$/mu.test(markdown) ||
    !/^## 来源$/mu.test(markdown)
  ) {
    throw new PublishingBundleError(
      'FINAL_MARKDOWN_INVALID',
      'The final Markdown must contain bilingual article and source sections.',
    )
  }
}

async function assertOperationBundle(operation, snapshot, blogRoot) {
  const articlePath = snapshot.articlePath
  const slug = snapshot.article.slug
  if (operation === 'probe') {
    const stagingRoot = path.join(blogRoot, '.staging')
    if (!isInside(stagingRoot, articlePath)) {
      throw new PublishingBundleError(
        'PROBE_ARTICLE_LOCATION_INVALID',
        'Probe JSON must be inside the private staging directory.',
      )
    }
    if (snapshot.article.coverImage !== undefined || snapshot.localAssets.length !== 0) {
      throw new PublishingBundleError(
        'PROBE_ASSETS_NOT_ALLOWED',
        'Probe JSON must not contain a local cover or local images.',
      )
    }
    return
  }

  if (path.dirname(articlePath) !== blogRoot) {
    throw new PublishingBundleError(
      'PUBLISH_ARTICLE_LOCATION_INVALID',
      'Publish JSON must be a direct child of the fixed blog directory.',
    )
  }
  await readFinalMarkdown(path.join(blogRoot, `${slug}.md`))

  const expectedCoverPath = `./assets/${slug}-cover.png`
  const cover = snapshot.article.coverImage
  if (
    !cover ||
    cover.source?.path !== expectedCoverPath ||
    typeof cover.alt?.en !== 'string' ||
    cover.alt.en.trim().length === 0 ||
    typeof cover.alt?.zh !== 'string' ||
    cover.alt.zh.trim().length === 0 ||
    !snapshot.localAssets.some((asset) => asset.filename === `${slug}-cover.png`)
  ) {
    throw new PublishingBundleError(
      'FINAL_COVER_REQUIRED',
      'Publish requires the exact generated local cover and bilingual alt text.',
    )
  }
}

export function parsePublishingArguments(args) {
  if (
    !Array.isArray(args) ||
    args.length !== 2 ||
    !['probe', 'publish'].includes(args[0]) ||
    typeof args[1] !== 'string' ||
    args[1].length === 0 ||
    args[1].startsWith('-')
  ) {
    throw new ArgumentError('只接受 probe <article.json> 或 publish <article.json> 两种参数。')
  }
  return {operation: args[0], articlePath: args[1]}
}

function isPublishedSlugConflict(error) {
  return (
    error instanceof PublisherApiError &&
    error.statusCode === 409 &&
    error.code === 'PUBLISH_CONFLICT'
  )
}

async function selectRemoteOperation(articlePath, requestOptions) {
  try {
    const dryRun = await requestArticle('dry-run', articlePath, requestOptions)
    return {mode: 'create', dryRun}
  } catch (error) {
    if (!isPublishedSlugConflict(error)) throw error
  }

  const dryRun = await requestArticle('update-dry-run', articlePath, requestOptions)
  return {mode: 'update', dryRun}
}

export async function runPublishingCommand(
  operation,
  articlePath,
  {
    workspaceRoot = WORKSPACE_ROOT,
    configOptions,
    fetchImpl = globalThis.fetch,
    timeoutMs,
  } = {},
) {
  if (!['probe', 'publish'].includes(operation)) {
    throw new ArgumentError('操作必须是 probe 或 publish。')
  }
  const workspace = await verifyWorkspace({workspaceRoot})
  const publishingConfig = await loadPublishingConfig(configOptions)
  const requestCredentials = publishingConfig.sanityToken
    ? {publishingConfig}
    : {token: publishingConfig.token}
  const snapshot = await prepareArticleSnapshot(articlePath, {blogRoot: workspace.blogRoot})
  await assertOperationBundle(operation, snapshot, workspace.blogRoot)
  await validateOutput(articlePath, {workspaceRoot})

  if (operation === 'probe') {
    const validation = await requestArticle('validate', articlePath, {
      blogRoot: workspace.blogRoot,
      ...requestCredentials,
      fetchImpl,
      snapshot,
      timeoutMs,
    })
    const selection = await selectRemoteOperation(articlePath, {
      blogRoot: workspace.blogRoot,
      ...requestCredentials,
      fetchImpl,
      snapshot,
      timeoutMs,
    })
    return {
      operation,
      mode: selection.mode,
      slug: selection.dryRun.data.slug,
      validation,
      dryRun: selection.dryRun,
    }
  }

  const validation = await requestArticle('validate', articlePath, {
    blogRoot: workspace.blogRoot,
    ...requestCredentials,
    fetchImpl,
    snapshot,
    timeoutMs,
  })
  const selection = await selectRemoteOperation(articlePath, {
    blogRoot: workspace.blogRoot,
    ...requestCredentials,
    fetchImpl,
    snapshot,
    timeoutMs,
  })
  const result = await requestArticle(selection.mode, articlePath, {
    blogRoot: workspace.blogRoot,
    ...requestCredentials,
    fetchImpl,
    snapshot,
    timeoutMs,
    ...(selection.mode === 'update'
      ? {expectedRevision: selection.dryRun.data.revision}
      : {}),
  })
  if (selection.mode === 'update' && result.data.id !== selection.dryRun.data.id) {
    throw new PublisherApiError({
      statusCode: 200,
      code: 'API_RESPONSE_INVALID',
      requestId: result.requestId,
      uploadedAssetIds: result.data.uploadedAssetIds,
    })
  }
  return {
    operation,
    mode: selection.mode,
    slug: result.data.slug,
    validation,
    dryRun: selection.dryRun,
    result,
    ...(selection.mode === 'create' ? {created: result} : {updated: result}),
  }
}

function safeError(error) {
  return {
    error: {
      code: typeof error?.code === 'string' ? error.code : 'PUBLISH_COMMAND_FAILED',
      ...(Number.isInteger(error?.statusCode) && error.statusCode > 0
        ? {statusCode: error.statusCode}
        : {}),
      ...(typeof error?.requestId === 'string' ? {requestId: error.requestId} : {}),
      ...(Array.isArray(error?.uploadedAssetIds) && error.uploadedAssetIds.length
        ? {uploadedAssetIds: error.uploadedAssetIds}
        : {}),
    },
  }
}

async function main() {
  const {operation, articlePath} = parsePublishingArguments(process.argv.slice(2))
  const result = await runPublishingCommand(operation, articlePath)
  console.log(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${JSON.stringify(safeError(error), null, 2)}\n`)
    process.exitCode = 1
  })
}
