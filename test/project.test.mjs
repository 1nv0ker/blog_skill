import assert from 'node:assert/strict'
import {readFile, readdir} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillRoot = path.join(projectRoot, 'skill', 'research-publish-sanity-blog')

async function listFiles(root, current = root) {
  const entries = await readdir(current, {withFileTypes: true})
  const files = []
  for (const entry of entries) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(root, full)))
    else files.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return files.sort()
}

test('skill leaf contains only runtime instructions, references, templates, and helpers', async () => {
  assert.deepEqual(await listFiles(skillRoot), [
    'SKILL.md',
    'agents/openai.yaml',
    'assets/blog-draft.template.md',
    'assets/blog-post.template.json',
    'references/article-contract.md',
    'references/editorial-workflow.md',
    'references/publishing-contract.md',
    'references/research-policy.md',
    'scripts/api-client.mjs',
    'scripts/config.mjs',
    'scripts/configure.mjs',
    'scripts/publish-output.mjs',
    'scripts/validate-output.mjs',
    'scripts/workspace.mjs',
  ])
})

test('SKILL.md has minimal frontmatter and the complete guarded workflow', async () => {
  const markdown = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown)?.[1]
  assert.ok(frontmatter)
  assert.deepEqual(
    frontmatter.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(0, line.indexOf(':'))),
    ['name', 'description'],
  )
  assert.match(frontmatter, /^name: research-publish-sanity-blog$/mu)
  assert.doesNotMatch(markdown, /\bTODO\b|\[TODO:/u)
  assert.match(markdown, /至少 3|at least 3/iu)
  assert.match(markdown, /不可信|untrusted/iu)
  assert.match(markdown, /初稿[\s\S]*润色|draft[\s\S]*polish/iu)
  assert.match(markdown, /blog[\\/]<slug>\.md/iu)
  assert.match(markdown, /imagegen|原创封面/iu)
  assert.match(markdown, /-vN/iu)
  assert.match(markdown, /probe[\s\S]*publish/iu)
  assert.match(markdown, /不再二次确认|无需二次确认|no second confirmation/iu)
  assert.match(markdown, /不得.*PUT|never.*PUT/iu)
  assert.ok(markdown.split(/\r?\n/u).length < 500)
})

test('openai.yaml disables implicit invocation and has valid UI metadata', async () => {
  const yaml = await readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
  assert.match(yaml, /display_name: "Research & Publish Sanity Blog"/u)
  assert.match(yaml, /short_description: "[^"]{25,64}"/u)
  assert.match(yaml, /default_prompt: ".*\$research-publish-sanity-blog.*"/u)
  assert.match(yaml, /policy:\s*\r?\n\s+allow_implicit_invocation: false/u)
})

test('templates define a bilingual Markdown draft and current article JSON shape', async () => {
  const draft = await readFile(path.join(skillRoot, 'assets', 'blog-draft.template.md'), 'utf8')
  assert.match(draft, /# English/u)
  assert.match(draft, /# 中文/u)
  assert.match(draft, /Sources/u)
  assert.match(draft, /来源/u)

  const template = JSON.parse(
    await readFile(path.join(skillRoot, 'assets', 'blog-post.template.json'), 'utf8'),
  )
  assert.deepEqual(Object.keys(template), [
    'title',
    'slug',
    'publishedAt',
    'excerpt',
    'coverImage',
    'body',
    'seo',
  ])
  assert.equal(template.coverImage.source.path, './assets/replace-with-article-slug-cover.png')
  assert.ok(Array.isArray(template.body.en) && template.body.en.length > 0)
  assert.ok(Array.isArray(template.body.zh) && template.body.zh.length > 0)
})

test('project README contains only safe local Skill installation instructions', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8')
  const example = await readFile(path.join(projectRoot, 'config.example.json'), 'utf8')
  assert.match(readme, /New-Item -ItemType Junction/u)
  assert.match(readme, /research-publish-sanity-blog/u)
  assert.match(readme, /目录联接|junction/iu)
  assert.match(readme, /\$research-publish-sanity-blog/u)
  assert.doesNotMatch(readme, /config\.local\.json|npm test|npm audit/u)
  assert.deepEqual(Object.keys(JSON.parse(example)), ['tokenFile'])
  assert.doesNotMatch(`${readme}\n${example}`, /skrqbOU4|X-Sanity-Token:\s*\S{20,}/u)
})

test('runtime files hard-code only the approved publisher origin', async () => {
  const apiClient = await readFile(path.join(skillRoot, 'scripts', 'api-client.mjs'), 'utf8')
  assert.match(apiClient, /https:\/\/publish\.miyaip\.com/u)
  assert.doesNotMatch(apiClient, /publisher\.example\.com|process\.env/u)
})
