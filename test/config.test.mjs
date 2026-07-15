import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ConfigError,
  assertTokenFilePermissions,
  loadPublishingConfig,
  writePublishingConfig,
} from '../skill/research-publish-sanity-blog/scripts/config.mjs'
import {
  parseConfigureArguments,
  runConfigureCommand,
} from '../skill/research-publish-sanity-blog/scripts/configure.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'research-publisher-config-'))
  const projectRoot = path.join(root, 'skill-project')
  const repositoryRoot = path.join(root, 'repository')
  const secretRoot = path.join(root, 'private-secrets')
  await Promise.all([
    mkdir(projectRoot, {recursive: true}),
    mkdir(repositoryRoot, {recursive: true}),
    mkdir(secretRoot, {recursive: true}),
  ])
  return {
    root,
    projectRoot,
    repositoryRoot,
    secretRoot,
    configPath: path.join(projectRoot, 'config.local.json'),
    tokenFile: path.join(secretRoot, 'sanity-token.txt'),
  }
}

test('loads a one-line token from an external regular file', async () => {
  const f = await fixture()
  await writeFile(f.tokenFile, 'opaque-test-token\n', {encoding: 'utf8', mode: 0o600})
  await writeFile(f.configPath, `${JSON.stringify({tokenFile: f.tokenFile}, null, 2)}\n`)

  const config = await loadPublishingConfig({
    configPath: f.configPath,
    projectRoot: f.projectRoot,
    repositoryRoot: f.repositoryRoot,
  })

  assert.equal(config.token, 'opaque-test-token')
  assert.equal(config.tokenFile, f.tokenFile)
})

test('missing configuration returns setup guidance without a token value', async () => {
  const f = await fixture()
  await assert.rejects(
    loadPublishingConfig({
      configPath: f.configPath,
      projectRoot: f.projectRoot,
      repositoryRoot: f.repositoryRoot,
    }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.code, 'CONFIG_MISSING')
      assert.match(error.message, /config\.local\.json|配置/)
      return true
    },
  )
})

test('rejects token files inside the repository or skill project', async () => {
  const f = await fixture()
  for (const unsafeRoot of [f.repositoryRoot, f.projectRoot]) {
    const tokenFile = path.join(unsafeRoot, 'sanity-token.txt')
    await writeFile(tokenFile, 'must-never-leak\n')
    await writeFile(f.configPath, `${JSON.stringify({tokenFile})}\n`)
    await assert.rejects(
      loadPublishingConfig({
        configPath: f.configPath,
        projectRoot: f.projectRoot,
        repositoryRoot: f.repositoryRoot,
      }),
      (error) => error instanceof ConfigError && error.code === 'TOKEN_LOCATION_UNSAFE',
    )
  }
})

test('rejects multiline, oversized, and extra-field configurations without leaking values', async () => {
  const f = await fixture()
  const cases = [
    ['line-one\nline-two\n', 'TOKEN_FORMAT_INVALID'],
    [`sensitive-${'x'.repeat(4097)}`, 'TOKEN_FORMAT_INVALID'],
  ]
  for (const [value, code] of cases) {
    await writeFile(f.tokenFile, value)
    await writeFile(f.configPath, `${JSON.stringify({tokenFile: f.tokenFile})}\n`)
    await assert.rejects(
      loadPublishingConfig({
        configPath: f.configPath,
        projectRoot: f.projectRoot,
        repositoryRoot: f.repositoryRoot,
      }),
      (error) => {
        assert.equal(error.code, code)
        assert.doesNotMatch(error.message, /line-one|sensitive-/)
        return true
      },
    )
  }

  await writeFile(f.tokenFile, 'opaque-test-token\n')
  await writeFile(
    f.configPath,
    `${JSON.stringify({tokenFile: f.tokenFile, token: 'embedded-secret'})}\n`,
  )
  await assert.rejects(
    loadPublishingConfig({
      configPath: f.configPath,
      projectRoot: f.projectRoot,
      repositoryRoot: f.repositoryRoot,
    }),
    (error) => error.code === 'CONFIG_INVALID' && !error.message.includes('embedded-secret'),
  )
})

test('rejects a symbolic-link token file when the platform permits creating one', async (t) => {
  const f = await fixture()
  const target = path.join(f.secretRoot, 'real-token.txt')
  await writeFile(target, 'opaque-test-token\n')
  try {
    await symlink(target, f.tokenFile, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('file symlinks require elevated privileges on this Windows installation')
      return
    }
    throw error
  }
  await writeFile(f.configPath, `${JSON.stringify({tokenFile: f.tokenFile})}\n`)
  await assert.rejects(
    loadPublishingConfig({
      configPath: f.configPath,
      projectRoot: f.projectRoot,
      repositoryRoot: f.repositoryRoot,
    }),
    (error) => error.code === 'TOKEN_FILE_INVALID',
  )
})

test('configuration writer stores only the external token path', async () => {
  const f = await fixture()
  await writeFile(f.tokenFile, 'opaque-test-token\n')
  await writePublishingConfig(f.tokenFile, {
    configPath: f.configPath,
    projectRoot: f.projectRoot,
    repositoryRoot: f.repositoryRoot,
  })

  const stored = await readFile(f.configPath, 'utf8')
  assert.deepEqual(JSON.parse(stored), {tokenFile: f.tokenFile})
  assert.doesNotMatch(stored, /opaque-test-token/)
})

test('configuration check validates the secret without printing or returning it', async () => {
  const output = []
  const result = await runConfigureCommand(['--check'], {
    loadConfig: async () => ({token: 'opaque-test-token', tokenFile: 'external'}),
    log: (value) => output.push(value),
  })

  assert.deepEqual(result, {mode: 'check'})
  assert.doesNotMatch(output.join('\n'), /opaque-test-token/)
  assert.deepEqual(parseConfigureArguments(['--check']), {mode: 'check'})
})

test('configuration check cannot be combined with a path or replace flag', () => {
  for (const args of [['--check', 'C:\\secret.txt'], ['--check', '--replace']]) {
    assert.throws(
      () => parseConfigureArguments(args),
      (error) => error.code === 'ARGUMENT_INVALID',
    )
  }
})

test('Windows ACL verification fails closed without exposing the token path', async () => {
  const f = await fixture()
  await writeFile(f.tokenFile, 'opaque-test-token\n')

  await assertTokenFilePermissions(f.tokenFile, {
    platform: 'win32',
    execFileImpl: async () => ({stdout: 'SAFE'}),
  })
  await assert.rejects(
    assertTokenFilePermissions(f.tokenFile, {
      platform: 'win32',
      execFileImpl: async () => {
        const error = new Error(`unsafe ${f.tokenFile}`)
        error.code = 41
        throw error
      },
    }),
    (error) =>
      error.code === 'TOKEN_PERMISSIONS_UNSAFE' && !error.message.includes(f.tokenFile),
  )
})
