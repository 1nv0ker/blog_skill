import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('evals cover successful research publishing and all critical stop conditions', async () => {
  const evals = JSON.parse(await readFile(path.join(projectRoot, 'evals', 'evals.json'), 'utf8'))
  assert.equal(evals.skill_name, 'research-publish-sanity-blog')
  assert.deepEqual(
    evals.evals.map((item) => item.id),
    [
      'research-polish-publish-webtransport',
      'ignore-web-prompt-injection',
      'missing-token-configuration',
      'remote-slug-versioning',
    ],
  )
  assert.ok(evals.evals[0].expectations.some((value) => /3.*source|3.*来源/iu.test(value)))
  assert.ok(evals.evals[0].expectations.some((value) => /cover|封面/iu.test(value)))
  assert.ok(evals.evals[1].expectations.some((value) => /ignore|忽略/iu.test(value)))
  assert.ok(evals.evals[2].expectations.some((value) => /no files|不.*文件/iu.test(value)))
  assert.ok(evals.evals[3].expectations.some((value) => /-v2/iu.test(value)))
})
