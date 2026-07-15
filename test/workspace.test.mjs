import assert from 'node:assert/strict'
import {lstat, mkdir, mkdtemp, readFile, rename, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  WorkspaceError,
  allocateLocalSlug,
  bundlePaths,
  commitReservation,
  parseWorkspaceArguments,
  prepareLocalBundle,
  releaseReservation,
  reserveLocalSlug,
  runWorkspaceCommand,
  verifyWorkspace,
} from '../skill/research-publish-sanity-blog/scripts/workspace.mjs'
import {validateOutput} from '../skill/research-publish-sanity-blog/scripts/validate-output.mjs'

async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'research-publisher-workspace-'))
  const blogRoot = path.join(workspaceRoot, 'blog')
  const publisherRoot = path.join(workspaceRoot, 'miya-saas', 'sanity-blog-publisher')
  await Promise.all([
    mkdir(path.join(blogRoot, 'assets'), {recursive: true}),
    mkdir(path.join(publisherRoot, 'src'), {recursive: true}),
  ])
  await writeFile(
    path.join(publisherRoot, 'package.json'),
    `${JSON.stringify({
      name: 'publisher',
      private: true,
      type: 'module',
      scripts: {validate: 'node src/cli.mjs validate'},
    })}\n`,
  )
  await writeFile(path.join(publisherRoot, 'src', 'cli.mjs'), 'process.exitCode = 0\n')
  return {workspaceRoot, blogRoot, publisherRoot}
}

async function writeBundle(blogRoot, slug, label = 'old') {
  const paths = bundlePaths(slug, {blogRoot})
  await writeFile(paths.markdown, `${label} markdown\n`)
  await writeFile(paths.article, `${JSON.stringify({slug, label})}\n`)
  await writeFile(
    paths.cover,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
  return paths
}

test('verifies the live publisher structurally without depending on its package name', async () => {
  const f = await fixture()
  const result = await verifyWorkspace({workspaceRoot: f.workspaceRoot})
  assert.equal(result.blogRoot, f.blogRoot)
  assert.equal(result.publisherRoot, f.publisherRoot)

  const manifestPath = path.join(f.publisherRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.name = 'renamed-publisher'
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  assert.equal((await verifyWorkspace({workspaceRoot: f.workspaceRoot})).publisherRoot, f.publisherRoot)
})

test('allocates the first free local slug and keeps suffixes within 96 characters', async () => {
  const f = await fixture()
  await writeFile(path.join(f.blogRoot, 'webtransport.md'), 'existing')
  await writeFile(path.join(f.blogRoot, 'webtransport-v2.json'), '{}')

  assert.equal(await allocateLocalSlug('webtransport', {blogRoot: f.blogRoot}), 'webtransport-v3')

  const long = 'a'.repeat(96)
  await writeFile(path.join(f.blogRoot, `${long}.md`), 'existing')
  const versioned = await allocateLocalSlug(long, {blogRoot: f.blogRoot})
  assert.equal(versioned.length, 96)
  assert.match(versioned, /-v2$/)
})

test('treats markdown, JSON, and cover files as one collision domain', async () => {
  const f = await fixture()
  await writeFile(path.join(f.blogRoot, 'assets', 'quic-cover.png'), 'existing')
  const slug = await allocateLocalSlug('quic', {blogRoot: f.blogRoot})
  assert.equal(slug, 'quic-v2')
  assert.deepEqual(bundlePaths(slug, {blogRoot: f.blogRoot}), {
    markdown: path.join(f.blogRoot, 'quic-v2.md'),
    article: path.join(f.blogRoot, 'quic-v2.json'),
    cover: path.join(f.blogRoot, 'assets', 'quic-v2-cover.png'),
  })
})

test('stops after ten occupied slug candidates', async () => {
  const f = await fixture()
  for (const slug of ['http3', ...Array.from({length: 9}, (_, index) => `http3-v${index + 2}`)]) {
    await writeFile(path.join(f.blogRoot, `${slug}.json`), '{}')
  }
  await assert.rejects(
    allocateLocalSlug('http3', {blogRoot: f.blogRoot}),
    (error) => error instanceof WorkspaceError && error.code === 'SLUG_EXHAUSTED',
  )
})

test('workspace command allocates a deterministic bundle from a requested version', async () => {
  const f = await fixture()
  const output = []
  const parsed = parseWorkspaceArguments(['allocate', 'webtransport', '--start=2'])
  assert.deepEqual(parsed, {baseSlug: 'webtransport', startVersion: 2})

  const result = await runWorkspaceCommand(['allocate', 'webtransport', '--start=2'], {
    workspaceRoot: f.workspaceRoot,
    log: (value) => output.push(value),
  })

  assert.equal(result.slug, 'webtransport-v2')
  assert.deepEqual(result.paths, bundlePaths('webtransport-v2', {blogRoot: f.blogRoot}))
  assert.deepEqual(JSON.parse(output.join('')), result)
})

test('workspace command exposes automatic prepare without a create/update argument', async () => {
  const f = await fixture()
  assert.deepEqual(parseWorkspaceArguments(['prepare', 'webtransport']), {
    operation: 'prepare',
    baseSlug: 'webtransport',
  })
  const output = []
  const result = await runWorkspaceCommand(['prepare', 'webtransport'], {
    workspaceRoot: f.workspaceRoot,
    log: (value) => output.push(value),
  })
  assert.equal(result.mode, 'create')
  assert.equal(JSON.parse(output.join('')).mode, 'create')
  await releaseReservation(result.slug, result.reservationId, {blogRoot: f.blogRoot})
})

test('workspace command rejects unsafe or exhausted start versions', () => {
  for (const args of [
    ['allocate', 'webtransport', '--start=0'],
    ['allocate', 'webtransport', '--start=11'],
    ['allocate', '../escape'],
    ['publish', 'webtransport'],
  ]) {
    assert.throws(
      () => parseWorkspaceArguments(args),
      (error) => error.code === 'ARGUMENT_INVALID' || error.code === 'SLUG_INVALID',
    )
  }
})

test('concurrent reservations atomically select different complete bundles', async () => {
  const f = await fixture()
  const [first, second] = await Promise.all([
    reserveLocalSlug('webtransport', {blogRoot: f.blogRoot}),
    reserveLocalSlug('webtransport', {blogRoot: f.blogRoot}),
  ])

  assert.deepEqual(new Set([first.slug, second.slug]), new Set(['webtransport', 'webtransport-v2']))
  assert.notEqual(first.reservationId, second.reservationId)
  const bySlug = new Map([first, second].map((item) => [item.slug, item]))
  assert.equal(bySlug.get('webtransport').nextStartVersion, 2)
  assert.equal(bySlug.get('webtransport-v2').nextStartVersion, 3)

  await Promise.all([
    releaseReservation(first.slug, first.reservationId, {blogRoot: f.blogRoot}),
    releaseReservation(second.slug, second.reservationId, {blogRoot: f.blogRoot}),
  ])
})

test('reservation commit copies a complete staging bundle without overwriting', async () => {
  const f = await fixture()
  const reservation = await reserveLocalSlug('quic', {blogRoot: f.blogRoot})
  await writeFile(reservation.staging.markdown, '# English\n\n## Sources\n\n# 中文\n\n## 来源\n')
  await writeFile(reservation.staging.article, `${JSON.stringify({slug: 'quic'})}\n`)
  await writeFile(
    reservation.staging.cover,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )

  const committed = await commitReservation('quic', reservation.reservationId, {
    blogRoot: f.blogRoot,
  })
  assert.deepEqual(committed.paths, bundlePaths('quic', {blogRoot: f.blogRoot}))
  assert.equal(await readFile(committed.paths.article, 'utf8'), `${JSON.stringify({slug: 'quic'})}\n`)

  const blocked = await reserveLocalSlug('http3', {blogRoot: f.blogRoot})
  await writeFile(blocked.staging.markdown, 'markdown')
  await writeFile(blocked.staging.article, '{}')
  await writeFile(blocked.staging.cover, 'cover')
  await writeFile(blocked.paths.article, 'existing')
  await assert.rejects(
    commitReservation(blocked.slug, blocked.reservationId, {blogRoot: f.blogRoot}),
    (error) => error.code === 'OUTPUT_COLLISION',
  )
  assert.equal(await readFile(blocked.paths.article, 'utf8'), 'existing')
  await releaseReservation(blocked.slug, blocked.reservationId, {blogRoot: f.blogRoot})
})

test('prepare automatically selects create or prefilled update without a user-facing mode flag', async () => {
  const f = await fixture()
  const created = await prepareLocalBundle('webtransport', {blogRoot: f.blogRoot})
  assert.equal(created.mode, 'create')
  await releaseReservation(created.slug, created.reservationId, {blogRoot: f.blogRoot})

  const oldPaths = await writeBundle(f.blogRoot, 'quic')
  const updating = await prepareLocalBundle('quic', {blogRoot: f.blogRoot})
  assert.equal(updating.mode, 'update')
  assert.equal(await readFile(updating.staging.markdown, 'utf8'), 'old markdown\n')
  assert.equal(
    JSON.parse(await readFile(updating.staging.article, 'utf8')).label,
    'old',
  )

  await writeFile(updating.staging.markdown, 'new markdown\n')
  await writeFile(updating.staging.article, `${JSON.stringify({slug: 'quic', label: 'new'})}\n`)
  await writeFile(
    updating.staging.cover,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
  )
  const committed = await commitReservation('quic', updating.reservationId, {
    blogRoot: f.blogRoot,
  })
  assert.equal(committed.mode, 'update')
  assert.equal(await readFile(oldPaths.markdown, 'utf8'), 'new markdown\n')
  assert.equal(JSON.parse(await readFile(oldPaths.article, 'utf8')).label, 'new')
})

test('prepare rejects partial bundles and update commit detects concurrent local changes', async () => {
  const f = await fixture()
  await writeFile(path.join(f.blogRoot, 'partial.md'), 'partial\n')
  await assert.rejects(
    prepareLocalBundle('partial', {blogRoot: f.blogRoot}),
    (error) => error.code === 'LOCAL_BUNDLE_INCOMPLETE',
  )

  const paths = await writeBundle(f.blogRoot, 'http3')
  const updating = await prepareLocalBundle('http3', {blogRoot: f.blogRoot})
  await writeFile(updating.staging.markdown, 'new markdown\n')
  await writeFile(updating.staging.article, `${JSON.stringify({slug: 'http3', label: 'new'})}\n`)
  await writeFile(
    updating.staging.cover,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
  )
  await writeFile(paths.markdown, 'concurrent edit\n')
  await assert.rejects(
    commitReservation('http3', updating.reservationId, {blogRoot: f.blogRoot}),
    (error) => error.code === 'OUTPUT_CHANGED',
  )
  assert.equal(await readFile(paths.markdown, 'utf8'), 'concurrent edit\n')
  await releaseReservation('http3', updating.reservationId, {blogRoot: f.blogRoot})
})

test('prepare bounds existing bundle reads and validates the PNG cover before staging', async () => {
  const f = await fixture()
  const oversized = await writeBundle(f.blogRoot, 'oversized')
  await writeFile(oversized.article, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20))
  await assert.rejects(
    prepareLocalBundle('oversized', {blogRoot: f.blogRoot}),
    (error) => error.code === 'LOCAL_BUNDLE_SIZE_INVALID',
  )

  const disguised = await writeBundle(f.blogRoot, 'disguised')
  await writeFile(disguised.cover, 'not a png')
  await assert.rejects(
    prepareLocalBundle('disguised', {blogRoot: f.blogRoot}),
    (error) => error.code === 'LOCAL_BUNDLE_COVER_INVALID',
  )
})

test('failed rollback preserves the only recoverable backup', async () => {
  const f = await fixture()
  const paths = await writeBundle(f.blogRoot, 'rollback')
  const updating = await prepareLocalBundle('rollback', {blogRoot: f.blogRoot})
  await writeFile(updating.staging.markdown, 'new markdown\n')
  await writeFile(updating.staging.article, `${JSON.stringify({slug: 'rollback', label: 'new'})}\n`)
  await writeFile(
    updating.staging.cover,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
  )

  const backup = `${paths.markdown}.${updating.reservationId}.backup`
  const renameImpl = async (source, destination) => {
    if (
      destination === paths.markdown &&
      (source.endsWith('.next') || source.endsWith('.backup'))
    ) {
      throw new Error('simulated locked destination')
    }
    await rename(source, destination)
  }
  await assert.rejects(
    commitReservation('rollback', updating.reservationId, {
      blogRoot: f.blogRoot,
      updateFileOps: {rename: renameImpl},
    }),
    (error) => error.code === 'OUTPUT_RECOVERY_REQUIRED',
  )
  assert.equal((await lstat(backup)).isFile(), true)
  assert.equal(await readFile(backup, 'utf8'), 'old markdown\n')

  await rename(backup, paths.markdown)
  await releaseReservation('rollback', updating.reservationId, {blogRoot: f.blogRoot})
})

test('reservation commands expose the next untried version after local skips', async () => {
  const f = await fixture()
  await writeFile(path.join(f.blogRoot, 'webtransport.md'), 'existing')
  await writeFile(path.join(f.blogRoot, 'webtransport-v2.json'), '{}')

  const output = []
  const result = await runWorkspaceCommand(['reserve', 'webtransport'], {
    workspaceRoot: f.workspaceRoot,
    log: (value) => output.push(value),
  })
  assert.equal(result.slug, 'webtransport-v3')
  assert.equal(result.version, 3)
  assert.equal(result.nextStartVersion, 4)
  assert.equal(JSON.parse(output.join('')).reservationId, result.reservationId)
  await runWorkspaceCommand(['release', result.slug, result.reservationId], {
    workspaceRoot: f.workspaceRoot,
    log: () => {},
  })
})

test('local validator runs only the trusted CLI and strips secret-like environment values', async () => {
  const f = await fixture()
  const record = path.join(f.workspaceRoot, 'record.json')
  await writeFile(
    path.join(f.publisherRoot, 'src', 'cli.mjs'),
    `import {writeFile} from 'node:fs/promises'\nawait writeFile(${JSON.stringify(record)}, JSON.stringify({args: process.argv.slice(2), sanity: process.env.SANITY_TOKEN ?? null, unrelated: process.env.UNRELATED_SECRET ?? null}))\n`,
  )
  const article = path.join(f.blogRoot, 'webtransport.json')
  await writeFile(article, '{}\n')

  const code = await validateOutput(article, {
    workspaceRoot: f.workspaceRoot,
    env: {...process.env, SANITY_TOKEN: 'never-forward', UNRELATED_SECRET: 'never-forward'},
  })

  assert.equal(code, 0)
  const recorded = JSON.parse(await readFile(record, 'utf8'))
  assert.deepEqual(recorded.args, ['validate', article])
  assert.equal(recorded.sanity, null)
  assert.equal(recorded.unrelated, null)
})

test('local validator rejects articles outside the fixed blog directory', async () => {
  const f = await fixture()
  const article = path.join(f.workspaceRoot, 'outside.json')
  await writeFile(article, '{}\n')
  await assert.rejects(
    validateOutput(article, {workspaceRoot: f.workspaceRoot}),
    (error) => error.code === 'ARTICLE_LOCATION_INVALID',
  )
})
