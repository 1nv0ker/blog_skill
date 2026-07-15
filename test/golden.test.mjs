import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {validateOutput} from '../skill/research-publish-sanity-blog/scripts/validate-output.mjs'
import {WORKSPACE_ROOT} from '../skill/research-publish-sanity-blog/scripts/workspace.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const fixtureRoot = path.join(projectRoot, 'evals', 'fixtures')

test('golden bilingual Markdown and JSON cover the editorial contract', async () => {
  const markdown = await readFile(path.join(fixtureRoot, 'webtransport.md'), 'utf8')
  assert.match(markdown, /^# English$/mu)
  assert.match(markdown, /^# 中文$/mu)
  assert.match(markdown, /^## Sources$/mu)
  assert.match(markdown, /^## 来源$/mu)
  assert.ok((markdown.match(/https:\/\//gu) ?? []).length >= 6)

  const article = JSON.parse(
    await readFile(path.join(fixtureRoot, 'skill-contract-example.json'), 'utf8'),
  )
  assert.ok(article.title.en && article.title.zh)
  assert.ok(article.seo.description.en && article.seo.description.zh)
  assert.equal(article.coverImage.source.path, './assets/skill-contract-example-cover.png')
  assert.ok(article.body.en.some((item) => item._type === 'code'))
  assert.ok(article.body.zh.some((item) => item._type === 'code'))
  assert.ok(JSON.stringify(article.body.en).includes('Sources'))
  assert.ok(JSON.stringify(article.body.zh).includes('来源'))
})

test('golden JSON and cover pass the current real publisher local validator', async () => {
  const liveBlogRoot = path.join(WORKSPACE_ROOT, 'blog')
  const temporaryRoot = await mkdtemp(path.join(liveBlogRoot, '.skill-contract-'))
  const assets = path.join(temporaryRoot, 'assets')
  await mkdir(assets)
  const articlePath = path.join(temporaryRoot, 'skill-contract-example.json')
  try {
    await writeFile(
      articlePath,
      await readFile(path.join(fixtureRoot, 'skill-contract-example.json')),
    )
    const encoded = (
      await readFile(path.join(fixtureRoot, 'skill-contract-example-cover.png.base64'), 'utf8')
    ).trim()
    await writeFile(
      path.join(assets, 'skill-contract-example-cover.png'),
      Buffer.from(encoded, 'base64'),
    )
    assert.equal(await validateOutput(articlePath), 0)
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true})
  }
})
