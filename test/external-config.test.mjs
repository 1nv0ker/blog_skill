import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ConfigError,
  configPathForHome,
  initializePublishingConfig,
  loadPublishingConfig,
} from '../skill/research-publish-sanity-blog/scripts/config.mjs'
import {
  parseConfigureArguments,
  runConfigureCommand,
} from '../skill/research-publish-sanity-blog/scripts/configure.mjs'

const VALID_CONFIG = Object.freeze({
  projectId: 'pcjr7pm7',
  dataset: 'production',
  apiVersion: '2026-07-05',
  sanityToken: 'opaque-test-token',
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'research-publisher-external-config-'))
  const projectRoot = path.join(root, 'skill-project')
  const repositoryRoot = path.join(root, 'repository')
  const configPath = path.join(
    root,
    'private-home',
    '.sanity-blog',
    'config.json',
  )
  await Promise.all([
    mkdir(projectRoot, {recursive: true}),
    mkdir(repositoryRoot, {recursive: true}),
  ])
  return {root, projectRoot, repositoryRoot, configPath}
}

function options(f) {
  return {
    configPath: f.configPath,
    projectRoot: f.projectRoot,
    repositoryRoot: f.repositoryRoot,
    permissionChecker: async () => {},
  }
}

test('derives one fixed external configuration path from the user home directory', () => {
  const home = path.resolve('C:\\Users\\example-user')
  assert.equal(
    configPathForHome(home),
    path.join(home, '.sanity-blog', 'config.json'),
  )
})

test('initialization creates one fill-in template and never overwrites it', async () => {
  const f = await fixture()
  await initializePublishingConfig(options(f))

  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), {
    projectId: 'pcjr7pm7',
    dataset: 'production',
    apiVersion: '2026-07-05',
    sanityToken: '',
  })
  await assert.rejects(
    initializePublishingConfig(options(f)),
    (error) => error instanceof ConfigError && error.code === 'CONFIG_EXISTS',
  )
})

test('loads target and token from the same external file', async () => {
  const f = await fixture()
  await mkdir(path.dirname(f.configPath), {recursive: true})
  await writeFile(f.configPath, `${JSON.stringify(VALID_CONFIG, null, 2)}\n`, {mode: 0o600})

  assert.deepEqual(await loadPublishingConfig(options(f)), VALID_CONFIG)
})

test('rejects malformed target fields, token content, and extra keys without leaks', async () => {
  const f = await fixture()
  await mkdir(path.dirname(f.configPath), {recursive: true})
  const cases = [
    [{...VALID_CONFIG, projectId: 'UPPER-project'}, 'SANITY_TARGET_INVALID'],
    [{...VALID_CONFIG, dataset: 'bad dataset'}, 'SANITY_TARGET_INVALID'],
    [{...VALID_CONFIG, apiVersion: '2026-02-30'}, 'SANITY_TARGET_INVALID'],
    [{...VALID_CONFIG, sanityToken: ''}, 'CONFIG_INCOMPLETE'],
    [{...VALID_CONFIG, sanityToken: 'line-one\nline-two'}, 'TOKEN_FORMAT_INVALID'],
    [{...VALID_CONFIG, extra: 'embedded-secret'}, 'CONFIG_INVALID'],
  ]

  for (const [value, code] of cases) {
    await writeFile(f.configPath, `${JSON.stringify(value)}\n`)
    await assert.rejects(loadPublishingConfig(options(f)), (error) => {
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /line-one|embedded-secret|UPPER-project/u)
      return true
    })
  }
})

test('configuration CLI accepts only init or check and never a path or token', async () => {
  assert.deepEqual(parseConfigureArguments(['--init']), {mode: 'init'})
  assert.deepEqual(parseConfigureArguments(['--check']), {mode: 'check'})
  for (const args of [[], ['--replace'], ['C:\\secret.txt'], ['--init', '--check']]) {
    assert.throws(
      () => parseConfigureArguments(args),
      (error) => error.code === 'ARGUMENT_INVALID',
    )
  }

  const output = []
  const result = await runConfigureCommand(['--check'], {
    loadConfig: async () => VALID_CONFIG,
    initializeConfig: async () => assert.fail('check must not initialize'),
    log: (value) => output.push(value),
  })
  assert.deepEqual(result, {mode: 'check'})
  assert.doesNotMatch(output.join('\n'), /opaque-test-token/u)
})

test('configuration init reports only the fixed file path for the user to fill', async () => {
  const output = []
  const result = await runConfigureCommand(['--init'], {
    loadConfig: async () => assert.fail('init must not read the empty template'),
    initializeConfig: async () => ({
      configPath: 'C:\\safe-home\\.sanity-blog\\config.json',
    }),
    log: (value) => output.push(value),
  })
  assert.deepEqual(result, {mode: 'init'})
  assert.match(output.join('\n'), /config\.json/u)
  assert.match(output.join('\n'), /fill|填写/iu)
  assert.doesNotMatch(output.join('\n'), /opaque-test-token/u)
})
