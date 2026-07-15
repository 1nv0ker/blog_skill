import {createHash, randomUUID} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

export const WORKSPACE_ROOT = 'C:\\work\\MIYA-LLC-WEB\\miyaip2026'
export const BLOG_RELATIVE_PATH = 'blog'
export const PUBLISHER_RELATIVE_PATH = path.join('miya-saas', 'sanity-blog-publisher')

const VALIDATE_COMMAND = 'node src/cli.mjs validate'
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_SLUG_LENGTH = 96
const MAX_CANDIDATES = 10
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
const MAX_COVER_BYTES = 20 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

async function canonicalDirectory(directory, code, message) {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid directory')
    return await realpath(directory)
  } catch {
    throw new WorkspaceError(code, message)
  }
}

async function canonicalFile(file, root, code, message) {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid file')
    const resolved = await realpath(file)
    if (!isInside(root, resolved)) throw new Error('outside root')
    return resolved
  } catch {
    throw new WorkspaceError(code, message)
  }
}

export async function verifyWorkspace({workspaceRoot = WORKSPACE_ROOT} = {}) {
  const root = await canonicalDirectory(
    path.resolve(workspaceRoot),
    'WORKSPACE_INVALID',
    '固定工作区不存在或不是普通目录。',
  )
  const blogRoot = await canonicalDirectory(
    path.join(root, BLOG_RELATIVE_PATH),
    'BLOG_DIRECTORY_INVALID',
    'blog 输出目录不存在或不安全。',
  )
  const publisherRoot = await canonicalDirectory(
    path.join(root, PUBLISHER_RELATIVE_PATH),
    'PUBLISHER_INVALID',
    '找不到受信任的 sanity-blog-publisher。',
  )
  const manifestPath = await canonicalFile(
    path.join(publisherRoot, 'package.json'),
    publisherRoot,
    'PUBLISHER_INVALID',
    'publisher package.json 不存在或不安全。',
  )
  const cli = await canonicalFile(
    path.join(publisherRoot, 'src', 'cli.mjs'),
    publisherRoot,
    'PUBLISHER_INVALID',
    'publisher CLI 不存在或不安全。',
  )

  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new WorkspaceError('PUBLISHER_INVALID', 'publisher package.json 无法解析。')
  }
  if (
    manifest?.private !== true ||
    manifest?.type !== 'module' ||
    manifest?.scripts?.validate !== VALIDATE_COMMAND
  ) {
    throw new WorkspaceError('PUBLISHER_INVALID', 'publisher CLI 合同不匹配。')
  }

  return {workspaceRoot: root, blogRoot, publisherRoot, publisherCli: cli}
}

export function assertBaseSlug(baseSlug) {
  if (
    typeof baseSlug !== 'string' ||
    !SLUG_PATTERN.test(baseSlug) ||
    baseSlug.length > MAX_SLUG_LENGTH
  ) {
    throw new WorkspaceError(
      'SLUG_INVALID',
      'slug 必须是最长 96 字符的 ASCII kebab-case。',
    )
  }
  return baseSlug
}

export function versionedSlug(baseSlug, version) {
  assertBaseSlug(baseSlug)
  if (version === 1) return baseSlug
  if (!Number.isInteger(version) || version < 2 || version > MAX_CANDIDATES) {
    throw new WorkspaceError('SLUG_VERSION_INVALID', 'slug 版本超出允许范围。')
  }
  const suffix = `-v${version}`
  const truncated = baseSlug.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/u, '')
  if (!truncated) throw new WorkspaceError('SLUG_INVALID', 'slug 无法添加版本后缀。')
  return `${truncated}${suffix}`
}

export function bundlePaths(slug, {blogRoot = path.join(WORKSPACE_ROOT, 'blog')} = {}) {
  assertBaseSlug(slug)
  return {
    markdown: path.join(blogRoot, `${slug}.md`),
    article: path.join(blogRoot, `${slug}.json`),
    cover: path.join(blogRoot, 'assets', `${slug}-cover.png`),
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new WorkspaceError('OUTPUT_CHECK_FAILED', '无法检查 blog 输出路径。')
  }
}

async function snapshotBundleFile(file, blogRoot, key) {
  try {
    const info = await lstat(file)
    const resolved = await realpath(file)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !isInside(blogRoot, resolved) ||
      resolved !== path.resolve(file)
    ) {
      throw new Error('unsafe file')
    }
    const maxBytes = key === 'cover' ? MAX_COVER_BYTES : MAX_TEXT_FILE_BYTES
    if (info.size <= 0 || info.size > maxBytes) {
      throw new WorkspaceError(
        'LOCAL_BUNDLE_SIZE_INVALID',
        'Existing blog bundle contains an empty or oversized file.',
      )
    }
    const bytes = await readFile(resolved)
    if (key === 'cover' && !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new WorkspaceError(
        'LOCAL_BUNDLE_COVER_INVALID',
        'Existing blog cover is not a valid PNG file.',
      )
    }
    return createHash('sha256').update(bytes).digest('hex')
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('LOCAL_BUNDLE_UNSAFE', 'Existing blog bundle is unsafe.')
  }
}

async function inspectLocalBundle(slug, blogRoot) {
  const paths = bundlePaths(slug, {blogRoot})
  const exists = await Promise.all(Object.values(paths).map(pathExists))
  const count = exists.filter(Boolean).length
  if (count === 0) return {mode: 'create', paths}
  if (count !== exists.length) {
    throw new WorkspaceError(
      'LOCAL_BUNDLE_INCOMPLETE',
      'Existing blog bundle must contain Markdown, JSON, and cover files.',
    )
  }
  const baseline = {}
  for (const key of ['markdown', 'article', 'cover']) {
    baseline[key] = await snapshotBundleFile(paths[key], blogRoot, key)
  }
  return {mode: 'update', paths, baseline}
}

function sameBaseline(left, right) {
  return (
    left?.markdown === right?.markdown &&
    left?.article === right?.article &&
    left?.cover === right?.cover
  )
}

export async function allocateLocalSlug(
  baseSlug,
  {blogRoot = path.join(WORKSPACE_ROOT, 'blog'), startVersion = 1} = {},
) {
  assertBaseSlug(baseSlug)
  if (!Number.isInteger(startVersion) || startVersion < 1 || startVersion > MAX_CANDIDATES) {
    throw new WorkspaceError('SLUG_VERSION_INVALID', 'slug start version must be from 1 to 10.')
  }
  for (let version = startVersion; version <= MAX_CANDIDATES; version += 1) {
    const candidate = versionedSlug(baseSlug, version)
    const paths = bundlePaths(candidate, {blogRoot})
    if (!(await Promise.all(Object.values(paths).map(pathExists))).some(Boolean)) return candidate
  }
  throw new WorkspaceError('SLUG_EXHAUSTED', '本地已占用前 10 个 slug 版本。')
}

const RESERVATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

async function ensureControlDirectory(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700})
  try {
    const info = await lstat(directory)
    const resolved = await realpath(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || resolved !== path.resolve(directory)) {
      throw new Error('unsafe control directory')
    }
  } catch {
    throw new WorkspaceError('CONTROL_DIRECTORY_INVALID', 'Skill control directory is unsafe.')
  }
}

function assertReservationId(reservationId) {
  if (typeof reservationId !== 'string' || !RESERVATION_ID_PATTERN.test(reservationId)) {
    throw new WorkspaceError('RESERVATION_INVALID', 'Reservation ID is invalid.')
  }
  return reservationId
}

function reservationLayout(slug, reservationId, blogRoot) {
  assertBaseSlug(slug)
  assertReservationId(reservationId)
  const stagingRoot = path.join(blogRoot, '.staging', reservationId)
  return {
    marker: path.join(blogRoot, '.reservations', `${slug}.json`),
    stagingRoot,
    staging: {
      markdown: path.join(stagingRoot, `${slug}.md`),
      article: path.join(stagingRoot, `${slug}.json`),
      cover: path.join(stagingRoot, 'assets', `${slug}-cover.png`),
    },
    paths: bundlePaths(slug, {blogRoot}),
  }
}

async function removeFileIfPresent(file) {
  try {
    await unlink(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function readReservation(slug, reservationId, blogRoot) {
  const layout = reservationLayout(slug, reservationId, blogRoot)
  let marker
  try {
    const info = await lstat(layout.marker)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 1024) {
      throw new Error('unsafe marker')
    }
    marker = JSON.parse(await readFile(layout.marker, 'utf8'))
  } catch {
    throw new WorkspaceError('RESERVATION_NOT_FOUND', 'Reservation was not found or is unsafe.')
  }
  const mode = marker?.mode ?? 'create'
  const validBaseline =
    mode === 'update' &&
    marker.baseline &&
    typeof marker.baseline === 'object' &&
    ['markdown', 'article', 'cover'].every(
      (key) => typeof marker.baseline[key] === 'string' && /^[0-9a-f]{64}$/u.test(marker.baseline[key]),
    )
  if (
    !marker ||
    typeof marker !== 'object' ||
    marker.slug !== slug ||
    marker.reservationId !== reservationId ||
    !['create', 'update'].includes(mode) ||
    (mode === 'update' && !validBaseline)
  ) {
    throw new WorkspaceError('RESERVATION_MISMATCH', 'Reservation ownership does not match.')
  }
  return {
    ...layout,
    reservation: {
      slug,
      reservationId,
      mode,
      ...(validBaseline ? {baseline: marker.baseline} : {}),
    },
  }
}

export async function reserveLocalSlug(
  baseSlug,
  {blogRoot = path.join(WORKSPACE_ROOT, 'blog'), startVersion = 1} = {},
) {
  assertBaseSlug(baseSlug)
  if (!Number.isInteger(startVersion) || startVersion < 1 || startVersion > MAX_CANDIDATES) {
    throw new WorkspaceError('SLUG_VERSION_INVALID', 'slug start version must be from 1 to 10.')
  }
  const reservationsRoot = path.join(blogRoot, '.reservations')
  const stagingRoot = path.join(blogRoot, '.staging')
  await Promise.all([
    ensureControlDirectory(reservationsRoot),
    ensureControlDirectory(stagingRoot),
  ])

  for (let version = startVersion; version <= MAX_CANDIDATES; version += 1) {
    const slug = versionedSlug(baseSlug, version)
    const paths = bundlePaths(slug, {blogRoot})
    if ((await Promise.all(Object.values(paths).map(pathExists))).some(Boolean)) continue

    const reservationId = randomUUID()
    const layout = reservationLayout(slug, reservationId, blogRoot)
    try {
      await writeFile(
        layout.marker,
        `${JSON.stringify({slug, reservationId, mode: 'create'})}\n`,
        {encoding: 'utf8', flag: 'wx', mode: 0o600},
      )
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw new WorkspaceError('RESERVATION_CREATE_FAILED', 'Unable to create slug reservation.')
    }

    try {
      if ((await Promise.all(Object.values(paths).map(pathExists))).some(Boolean)) {
        await removeFileIfPresent(layout.marker)
        continue
      }
      await mkdir(path.dirname(layout.staging.cover), {recursive: true, mode: 0o700})
      return {
        slug,
        version,
        nextStartVersion: version < MAX_CANDIDATES ? version + 1 : null,
        reservationId,
        staging: layout.staging,
        paths,
      }
    } catch (error) {
      await removeFileIfPresent(layout.marker).catch(() => {})
      if (error instanceof WorkspaceError) throw error
      throw new WorkspaceError('RESERVATION_CREATE_FAILED', 'Unable to prepare staging directory.')
    }
  }
  throw new WorkspaceError('SLUG_EXHAUSTED', 'No free local slug remains in the first 10 versions.')
}

export async function prepareLocalBundle(
  baseSlug,
  {blogRoot = path.join(WORKSPACE_ROOT, 'blog')} = {},
) {
  const slug = assertBaseSlug(baseSlug)
  const reservationsRoot = path.join(blogRoot, '.reservations')
  const stagingRoot = path.join(blogRoot, '.staging')
  await Promise.all([
    ensureControlDirectory(reservationsRoot),
    ensureControlDirectory(stagingRoot),
  ])

  const state = await inspectLocalBundle(slug, blogRoot)
  const reservationId = randomUUID()
  const layout = reservationLayout(slug, reservationId, blogRoot)
  const marker = {
    slug,
    reservationId,
    mode: state.mode,
    ...(state.mode === 'update' ? {baseline: state.baseline} : {}),
  }
  try {
    await writeFile(layout.marker, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new WorkspaceError('SLUG_BUSY', 'This slug is already being prepared by another run.')
    }
    throw new WorkspaceError('RESERVATION_CREATE_FAILED', 'Unable to create slug reservation.')
  }

  try {
    await mkdir(path.dirname(layout.staging.cover), {recursive: true, mode: 0o700})
    const current = await inspectLocalBundle(slug, blogRoot)
    if (current.mode !== state.mode || !sameBaseline(current.baseline, state.baseline)) {
      throw new WorkspaceError(
        'OUTPUT_CHANGED',
        'The local blog bundle changed while the update was being prepared.',
      )
    }
    if (state.mode === 'update') {
      for (const key of ['markdown', 'cover', 'article']) {
        await copyFile(state.paths[key], layout.staging[key], fsConstants.COPYFILE_EXCL)
      }
      const afterCopy = await inspectLocalBundle(slug, blogRoot)
      if (afterCopy.mode !== 'update' || !sameBaseline(afterCopy.baseline, state.baseline)) {
        throw new WorkspaceError(
          'OUTPUT_CHANGED',
          'The local blog bundle changed while staging copies were created.',
        )
      }
    }
    return {
      slug,
      mode: state.mode,
      reservationId,
      staging: layout.staging,
      paths: state.paths,
    }
  } catch (error) {
    await rm(layout.stagingRoot, {recursive: true, force: true}).catch(() => {})
    await removeFileIfPresent(layout.marker).catch(() => {})
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('RESERVATION_CREATE_FAILED', 'Unable to prepare staging directory.')
  }
}

export async function releaseReservation(
  slug,
  reservationId,
  {blogRoot = path.join(WORKSPACE_ROOT, 'blog')} = {},
) {
  const layout = await readReservation(slug, reservationId, blogRoot)
  await rm(layout.stagingRoot, {recursive: true, force: true})
  await removeFileIfPresent(layout.marker)
  return {released: true, slug}
}

async function assertStagingFile(file, stagingRoot) {
  try {
    const info = await lstat(file)
    const resolved = await realpath(file)
    if (!info.isFile() || info.isSymbolicLink() || !isInside(stagingRoot, resolved)) {
      throw new Error('unsafe staging file')
    }
    return resolved
  } catch {
    throw new WorkspaceError('STAGING_BUNDLE_INCOMPLETE', 'Staging bundle is incomplete or unsafe.')
  }
}

async function assertUnchangedUpdateBundle(layout, blogRoot) {
  const current = await inspectLocalBundle(layout.reservation.slug, blogRoot)
  if (
    current.mode !== 'update' ||
    !sameBaseline(current.baseline, layout.reservation.baseline)
  ) {
    throw new WorkspaceError(
      'OUTPUT_CHANGED',
      'The existing blog bundle changed after update preparation began.',
    )
  }
}

async function replaceUpdateBundle(layout, sources, blogRoot, fileOps = {}) {
  const copyFileImpl = fileOps.copyFile ?? copyFile
  const renameImpl = fileOps.rename ?? rename
  const removeFileImpl = fileOps.removeFile ?? removeFileIfPresent
  await assertUnchangedUpdateBundle(layout, blogRoot)
  const keys = ['markdown', 'cover', 'article']
  const temporary = {}
  const backups = {}
  for (const key of keys) {
    temporary[key] = `${layout.paths[key]}.${layout.reservation.reservationId}.next`
    backups[key] = `${layout.paths[key]}.${layout.reservation.reservationId}.backup`
  }

  const installed = []
  const moved = []
  try {
    for (const key of keys) {
      await copyFileImpl(sources[key], temporary[key], fsConstants.COPYFILE_EXCL)
    }
    await assertUnchangedUpdateBundle(layout, blogRoot)
    for (const key of keys) {
      await renameImpl(layout.paths[key], backups[key])
      moved.push(key)
      await renameImpl(temporary[key], layout.paths[key])
      installed.push(key)
    }
  } catch (error) {
    const recoveryFailures = []
    for (const key of [...moved].reverse()) {
      try {
        if (installed.includes(key)) await removeFileImpl(layout.paths[key])
        await renameImpl(backups[key], layout.paths[key])
      } catch {
        recoveryFailures.push(key)
      }
    }
    await Promise.all(
      Object.values(temporary).map((file) => removeFileImpl(file).catch(() => {})),
    )
    if (recoveryFailures.length) {
      throw new WorkspaceError(
        'OUTPUT_RECOVERY_REQUIRED',
        'Local bundle rollback was incomplete; recovery backups were preserved.',
      )
    }
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('OUTPUT_COMMIT_FAILED', 'Unable to replace the complete output bundle.')
  }

  await Promise.all(Object.values(backups).map((file) => removeFileImpl(file)))
}

export async function commitReservation(
  slug,
  reservationId,
  {blogRoot = path.join(WORKSPACE_ROOT, 'blog'), updateFileOps} = {},
) {
  const layout = await readReservation(slug, reservationId, blogRoot)
  const sources = {
    markdown: await assertStagingFile(layout.staging.markdown, layout.stagingRoot),
    cover: await assertStagingFile(layout.staging.cover, layout.stagingRoot),
    article: await assertStagingFile(layout.staging.article, layout.stagingRoot),
  }
  if (layout.reservation.mode === 'update') {
    await replaceUpdateBundle(layout, sources, blogRoot, updateFileOps)
  } else {
    if ((await Promise.all(Object.values(layout.paths).map(pathExists))).some(Boolean)) {
      throw new WorkspaceError('OUTPUT_COLLISION', 'A final output appeared after reservation.')
    }

    const created = []
    try {
      for (const key of ['markdown', 'cover', 'article']) {
        await copyFile(sources[key], layout.paths[key], fsConstants.COPYFILE_EXCL)
        created.push(layout.paths[key])
      }
    } catch {
      await Promise.all(created.map((file) => removeFileIfPresent(file).catch(() => {})))
      throw new WorkspaceError('OUTPUT_COMMIT_FAILED', 'Unable to commit the complete output bundle.')
    }
  }

  await rm(layout.stagingRoot, {recursive: true, force: true})
  await removeFileIfPresent(layout.marker)
  return {slug, mode: layout.reservation.mode, paths: layout.paths}
}

function argumentError() {
  return new WorkspaceError(
    'ARGUMENT_INVALID',
    'Use prepare <base-slug>, allocate/reserve <base-slug> [--start=1..10], or commit/release <slug> <reservation-id>.',
  )
}

export function parseWorkspaceArguments(args) {
  if (!Array.isArray(args) || args.length < 2 || args.length > 3) throw argumentError()
  if (args[0] === 'prepare' && args.length === 2) {
    return {operation: 'prepare', baseSlug: assertBaseSlug(args[1])}
  }
  if (['allocate', 'reserve'].includes(args[0])) {
    const baseSlug = assertBaseSlug(args[1])
    let startVersion = 1
    if (args.length === 3) {
      const match = /^--start=(\d{1,2})$/u.exec(args[2])
      if (!match) throw argumentError()
      startVersion = Number(match[1])
      if (startVersion < 1 || startVersion > MAX_CANDIDATES) throw argumentError()
    }
    return args[0] === 'allocate'
      ? {baseSlug, startVersion}
      : {operation: 'reserve', baseSlug, startVersion}
  }
  if (['commit', 'release'].includes(args[0]) && args.length === 3) {
    return {
      operation: args[0],
      slug: assertBaseSlug(args[1]),
      reservationId: assertReservationId(args[2]),
    }
  }
  throw argumentError()
}

export async function runWorkspaceCommand(
  args,
  {workspaceRoot = WORKSPACE_ROOT, log = console.log} = {},
) {
  const parsed = parseWorkspaceArguments(args)
  const workspace = await verifyWorkspace({workspaceRoot})
  let result
  if (args[0] === 'allocate') {
    const slug = await allocateLocalSlug(parsed.baseSlug, {
      blogRoot: workspace.blogRoot,
      startVersion: parsed.startVersion,
    })
    result = {slug, paths: bundlePaths(slug, {blogRoot: workspace.blogRoot})}
  } else if (parsed.operation === 'prepare') {
    result = await prepareLocalBundle(parsed.baseSlug, {blogRoot: workspace.blogRoot})
  } else if (parsed.operation === 'reserve') {
    result = await reserveLocalSlug(parsed.baseSlug, {
      blogRoot: workspace.blogRoot,
      startVersion: parsed.startVersion,
    })
  } else if (parsed.operation === 'commit') {
    result = await commitReservation(parsed.slug, parsed.reservationId, {
      blogRoot: workspace.blogRoot,
    })
  } else {
    result = await releaseReservation(parsed.slug, parsed.reservationId, {
      blogRoot: workspace.blogRoot,
    })
  }
  log(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

async function main() {
  await runWorkspaceCommand(process.argv.slice(2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${JSON.stringify({error: {code: error?.code ?? 'WORKSPACE_COMMAND_FAILED'}})}\n`)
    process.exitCode = 1
  })
}
