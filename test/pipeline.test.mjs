import assert from 'node:assert/strict'
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  parsePublishingArguments,
  runPublishingCommand,
} from '../skill/research-publish-sanity-blog/scripts/publish-output.mjs'

const API_ORIGIN = 'https://publisher.pipeline.example.test'

const SANITY_TARGET = Object.freeze({
  projectId: 'pcjr7pm7',
  dataset: 'production',
  apiVersion: '2026-07-05',
})

function article() {
  return {
    title: {en: 'QUIC Guide', zh: 'QUIC 指南'},
    slug: 'quic-guide',
    publishedAt: '2026-07-15T00:00:00.000Z',
    coverImage: {
      source: {path: './assets/quic-guide-cover.png'},
      alt: {en: 'QUIC connection diagram', zh: 'QUIC connection diagram'},
    },
    excerpt: {en: 'A QUIC guide.', zh: '一份 QUIC 指南。'},
    body: {
      en: [{_type: 'block', children: [{_type: 'span', text: 'English', marks: []}]}],
      zh: [{_type: 'block', children: [{_type: 'span', text: '中文', marks: []}]}],
    },
    seo: {
      title: {en: 'QUIC Guide', zh: 'QUIC 指南'},
      description: {en: 'A QUIC guide.', zh: '一份 QUIC 指南。'},
    },
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'research-publisher-pipeline-'))
  const workspaceRoot = path.join(root, 'workspace')
  const blogRoot = path.join(workspaceRoot, 'blog')
  const publisherRoot = path.join(workspaceRoot, 'miya-saas', 'sanity-blog-publisher')
  const projectRoot = path.join(root, 'skill-project')
  const secrets = path.join(root, 'secrets')
  await Promise.all([
    mkdir(path.join(blogRoot, 'assets'), {recursive: true}),
    mkdir(path.join(blogRoot, '.staging'), {recursive: true}),
    mkdir(path.join(publisherRoot, 'src'), {recursive: true}),
    mkdir(projectRoot),
    mkdir(secrets),
  ])
  await writeFile(
    path.join(publisherRoot, 'package.json'),
    `${JSON.stringify({private: true, type: 'module', scripts: {validate: 'node src/cli.mjs validate'}})}\n`,
  )
  await writeFile(path.join(publisherRoot, 'src', 'cli.mjs'), 'process.exitCode = 0\n')
  const articlePath = path.join(blogRoot, 'quic-guide.json')
  await writeFile(articlePath, `${JSON.stringify(article(), null, 2)}\n`)
  await writeFile(
    path.join(blogRoot, 'quic-guide.md'),
    '# English\n\n# QUIC Guide\n\n## Sources\n\n- Official source\n\n# 中文\n\n# QUIC 指南\n\n## 来源\n\n- 官方来源\n',
  )
  await writeFile(
    path.join(blogRoot, 'assets', 'quic-guide-cover.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
  const stagingArticle = article()
  delete stagingArticle.coverImage
  const probeArticlePath = path.join(blogRoot, '.staging', 'quic-guide.json')
  await writeFile(probeArticlePath, `${JSON.stringify(stagingArticle, null, 2)}\n`)
  const configPath = path.join(secrets, 'config.json')
  await writeFile(
    configPath,
    `${JSON.stringify({publisherApiOrigin: API_ORIGIN, ...SANITY_TARGET, sanityToken: 'opaque-pipeline-token'}, null, 2)}\n`,
    {mode: 0o600},
  )
  return {
    root,
    workspaceRoot,
    blogRoot,
    projectRoot,
    configPath,
    articlePath,
    probeArticlePath,
  }
}

function successResponse(url) {
  if (url.endsWith('/v1/blog-post-validations')) {
    return new Response(
      JSON.stringify({
        data: {valid: true, slug: 'quic-guide', bodyBlocks: {en: 1, zh: 1}, localImageCount: 0},
        requestId: 'validation-id',
      }),
      {status: 200, headers: {'content-type': 'application/json'}},
    )
  }
  if (url.endsWith('?dryRun=true')) {
    return new Response(
      JSON.stringify({
        data: {
          status: 'dry-run',
          mode: 'create',
          slug: 'quic-guide',
          uploadedAssetIds: [],
          target: SANITY_TARGET,
        },
        requestId: 'dry-id',
      }),
      {status: 200, headers: {'content-type': 'application/json'}},
    )
  }
  return new Response(
    JSON.stringify({
      data: {
        status: 'published',
        mode: 'created',
        id: 'created-id',
        revision: 'created-rev',
        slug: 'quic-guide',
        uploadedAssetIds: [],
        target: SANITY_TARGET,
      },
      requestId: 'create-id',
    }),
    {status: 201, headers: {'content-type': 'application/json'}},
  )
}

test('probe performs public validation then dry-run without creating', async () => {
  const f = await fixture()
  const calls = []
  const result = await runPublishingCommand('probe', f.probeArticlePath, {
    workspaceRoot: f.workspaceRoot,
    configOptions: {
      configPath: f.configPath,
      projectRoot: f.projectRoot,
      repositoryRoot: f.workspaceRoot,
    },
    fetchImpl: async (url, init) => {
      calls.push({url, init})
      return successResponse(url)
    },
  })

  assert.equal(result.validation.requestId, 'validation-id')
  assert.equal(result.dryRun.requestId, 'dry-id')
  assert.deepEqual(calls.map((call) => call.url), [
    `${API_ORIGIN}/v1/blog-post-validations`,
    `${API_ORIGIN}/v1/blog-posts?dryRun=true`,
  ])
  assert.equal(calls[0].init.headers['X-Sanity-Token'], undefined)
  assert.equal(calls[1].init.headers['X-Sanity-Token'], 'opaque-pipeline-token')
  assert.equal(calls[1].init.headers['X-Sanity-Project-Id'], 'pcjr7pm7')
  assert.equal(calls[1].init.headers['X-Sanity-Dataset'], 'production')
  assert.equal(calls[1].init.headers['X-Sanity-Api-Version'], '2026-07-05')
})

test('publish enforces validation then dry-run then one create request', async () => {
  const f = await fixture()
  const calls = []
  const result = await runPublishingCommand('publish', f.articlePath, {
    workspaceRoot: f.workspaceRoot,
    configOptions: {
      configPath: f.configPath,
      projectRoot: f.projectRoot,
      repositoryRoot: f.workspaceRoot,
    },
    fetchImpl: async (url, init) => {
      calls.push({url, init})
      return successResponse(url)
    },
  })

  assert.equal(result.created.data.id, 'created-id')
  assert.deepEqual(calls.map((call) => call.url), [
    `${API_ORIGIN}/v1/blog-post-validations`,
    `${API_ORIGIN}/v1/blog-posts?dryRun=true`,
    `${API_ORIGIN}/v1/blog-posts`,
  ])
  assert.equal(calls[0].init.headers['X-Sanity-Token'], undefined)
  assert.equal(calls[1].init.headers['X-Sanity-Token'], 'opaque-pipeline-token')
  assert.equal(calls[2].init.headers['X-Sanity-Token'], 'opaque-pipeline-token')
  assert.equal(calls[2].init.headers['X-Sanity-Project-Id'], 'pcjr7pm7')
})

test('publish stops before create when dry-run fails', async () => {
  const f = await fixture()
  const calls = []
  await assert.rejects(
    runPublishingCommand('publish', f.articlePath, {
      workspaceRoot: f.workspaceRoot,
      configOptions: {
        configPath: f.configPath,
        projectRoot: f.projectRoot,
        repositoryRoot: f.workspaceRoot,
      },
      fetchImpl: async (url, init) => {
        calls.push({url, init})
        if (url.endsWith('?dryRun=true')) {
          return new Response(
            JSON.stringify({
              error: {code: 'PUBLISH_CONFLICT', message: 'slug exists'},
              requestId: 'conflict-id',
            }),
            {status: 409, headers: {'content-type': 'application/json'}},
          )
        }
        return successResponse(url)
      },
    }),
    (error) => error.code === 'PUBLISH_CONFLICT' && error.requestId === 'conflict-id',
  )
  assert.equal(calls.length, 2)
})

test('publish validates, dry-runs, and creates from one immutable article snapshot', async () => {
  const f = await fixture()
  const changed = article()
  changed.title.en = 'Changed after validation'
  const sentTitles = []

  await runPublishingCommand('publish', f.articlePath, {
    workspaceRoot: f.workspaceRoot,
    configOptions: {
      configPath: f.configPath,
      projectRoot: f.projectRoot,
      repositoryRoot: f.workspaceRoot,
    },
    fetchImpl: async (url, init) => {
      const articlePart = init.body instanceof FormData ? init.body.get('article') : init.body
      const sent = JSON.parse(
        articlePart instanceof Blob
          ? await articlePart.text()
          : Buffer.from(articlePart).toString('utf8'),
      )
      sentTitles.push(sent.title.en)
      if (url.endsWith('/v1/blog-post-validations')) {
        await writeFile(f.articlePath, `${JSON.stringify(changed, null, 2)}\n`)
      }
      return successResponse(url)
    },
  })

  assert.deepEqual(sentTitles, ['QUIC Guide', 'QUIC Guide', 'QUIC Guide'])
})

test('probe accepts staging only while publish requires final Markdown and exact local cover', async () => {
  const f = await fixture()
  const common = {
    workspaceRoot: f.workspaceRoot,
    configOptions: {
      configPath: f.configPath,
      projectRoot: f.projectRoot,
      repositoryRoot: f.workspaceRoot,
    },
    fetchImpl: async (url) => successResponse(url),
  }

  await assert.rejects(
    runPublishingCommand('probe', f.articlePath, common),
    (error) => error.code === 'PROBE_ARTICLE_LOCATION_INVALID',
  )
  await assert.rejects(
    runPublishingCommand('publish', f.probeArticlePath, common),
    (error) => error.code === 'PUBLISH_ARTICLE_LOCATION_INVALID',
  )

  const withoutCover = article()
  delete withoutCover.coverImage
  await writeFile(f.articlePath, `${JSON.stringify(withoutCover, null, 2)}\n`)
  await assert.rejects(
    runPublishingCommand('publish', f.articlePath, common),
    (error) => error.code === 'FINAL_COVER_REQUIRED',
  )
})

test('CLI arguments reject token flags and expose only probe or publish', () => {
  assert.deepEqual(parsePublishingArguments(['probe', 'C:\\blog\\article.json']), {
    operation: 'probe',
    articlePath: 'C:\\blog\\article.json',
  })
  assert.deepEqual(parsePublishingArguments(['publish', 'C:\\blog\\article.json']), {
    operation: 'publish',
    articlePath: 'C:\\blog\\article.json',
  })
  for (const args of [
    ['create', 'article.json'],
    ['publish', 'article.json', '--token=secret'],
    ['publish'],
  ]) {
    assert.throws(() => parsePublishingArguments(args), /probe|publish|参数/)
  }
})
