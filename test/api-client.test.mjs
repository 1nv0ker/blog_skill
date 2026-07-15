import assert from 'node:assert/strict'
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  API_ORIGIN,
  PublisherApiError,
  buildArticleRequest,
  requestArticle,
} from '../skill/research-publish-sanity-blog/scripts/api-client.mjs'

function article(slug = 'webtransport-guide') {
  return {
    title: {en: 'WebTransport Guide', zh: 'WebTransport 指南'},
    slug,
    publishedAt: '2026-07-15T00:00:00.000Z',
    excerpt: {en: 'A technical guide.', zh: '一份技术指南。'},
    body: {
      en: [{_type: 'block', children: [{_type: 'span', text: 'English', marks: []}]}],
      zh: [{_type: 'block', children: [{_type: 'span', text: '中文', marks: []}]}],
    },
    seo: {
      title: {en: 'WebTransport Guide', zh: 'WebTransport 指南'},
      description: {en: 'A technical guide.', zh: '一份技术指南。'},
    },
  }
}

async function fixture(document = article()) {
  const blogRoot = await mkdtemp(path.join(tmpdir(), 'research-publisher-api-'))
  const assets = path.join(blogRoot, 'assets')
  await mkdir(assets)
  const articlePath = path.join(blogRoot, `${document.slug}.json`)
  await writeFile(articlePath, `${JSON.stringify(document, null, 2)}\n`)
  return {blogRoot, assets, articlePath}
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

const PUBLISHING_CONFIG = Object.freeze({
  projectId: 'pcjr7pm7',
  dataset: 'production',
  apiVersion: '2026-07-05',
  sanityToken: 'opaque-config-token',
})

test('configured requests send the complete target and require the API to echo it', async () => {
  const f = await fixture()
  const calls = []
  const expectedTarget = {
    projectId: PUBLISHING_CONFIG.projectId,
    dataset: PUBLISHING_CONFIG.dataset,
    apiVersion: PUBLISHING_CONFIG.apiVersion,
  }
  const result = await requestArticle('dry-run', f.articlePath, {
    blogRoot: f.blogRoot,
    publishingConfig: PUBLISHING_CONFIG,
    fetchImpl: async (url, init) => {
      calls.push({url, init})
      return response({
        data: {
          status: 'dry-run',
          mode: 'create',
          slug: 'webtransport-guide',
          uploadedAssetIds: [],
          target: expectedTarget,
        },
        requestId: 'configured-dry-run',
      })
    },
  })

  assert.deepEqual(result.data.target, expectedTarget)
  assert.equal(calls[0].init.headers['X-Sanity-Project-Id'], 'pcjr7pm7')
  assert.equal(calls[0].init.headers['X-Sanity-Dataset'], 'production')
  assert.equal(calls[0].init.headers['X-Sanity-Api-Version'], '2026-07-05')
  assert.equal(calls[0].init.headers['X-Sanity-Token'], 'opaque-config-token')
  assert.doesNotMatch(calls[0].url, /pcjr7pm7|opaque-config-token/u)

  await assert.rejects(
    requestArticle('dry-run', f.articlePath, {
      blogRoot: f.blogRoot,
      publishingConfig: PUBLISHING_CONFIG,
      fetchImpl: async () =>
        response({
          data: {
            status: 'dry-run',
            mode: 'create',
            slug: 'webtransport-guide',
            uploadedAssetIds: [],
          },
          requestId: 'old-server-response',
        }),
    }),
    (error) => error.code === 'API_RESPONSE_INVALID',
  )
})

test('validation uses the fixed HTTPS endpoint without sending a token', async () => {
  const f = await fixture()
  const calls = []
  const result = await requestArticle('validate', f.articlePath, {
    blogRoot: f.blogRoot,
    token: 'must-not-be-sent',
    fetchImpl: async (url, init) => {
      calls.push({url, init})
      return response({
        data: {valid: true, slug: 'webtransport-guide', bodyBlocks: {en: 1, zh: 1}, localImageCount: 0},
        requestId: 'validation-request',
      })
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API_ORIGIN}/v1/blog-post-validations`)
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers['X-Sanity-Token'], undefined)
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(result.requestId, 'validation-request')
})

test('dry-run and create send the token only in X-Sanity-Token and validate envelopes', async () => {
  const f = await fixture()
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({url, init})
    const dryRun = url.endsWith('?dryRun=true')
    return response(
      {
        data: dryRun
          ? {status: 'dry-run', mode: 'create', slug: 'webtransport-guide', uploadedAssetIds: []}
          : {
              status: 'published',
              mode: 'created',
              id: 'post-id',
              revision: 'post-rev',
              slug: 'webtransport-guide',
              uploadedAssetIds: [],
            },
        requestId: dryRun ? 'dry-request' : 'create-request',
      },
      dryRun ? 200 : 201,
    )
  }

  const dry = await requestArticle('dry-run', f.articlePath, {
    blogRoot: f.blogRoot,
    token: 'opaque-test-token',
    fetchImpl,
  })
  const created = await requestArticle('create', f.articlePath, {
    blogRoot: f.blogRoot,
    token: 'opaque-test-token',
    fetchImpl,
  })

  assert.equal(dry.data.status, 'dry-run')
  assert.equal(created.data.id, 'post-id')
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${API_ORIGIN}/v1/blog-posts?dryRun=true`, `${API_ORIGIN}/v1/blog-posts`],
  )
  for (const call of calls) {
    assert.equal(call.init.headers['X-Sanity-Token'], 'opaque-test-token')
    assert.equal(call.init.redirect, 'error')
    assert.doesNotMatch(call.url, /opaque-test-token/)
  }
})

test('multipart request uploads each referenced local asset exactly once', async () => {
  const document = article()
  document.coverImage = {
    source: {path: './assets/webtransport-guide-cover.png'},
    alt: {en: 'Cover', zh: '封面'},
  }
  document.body.en.push({
    _type: 'image',
    source: {path: './assets/webtransport-guide-cover.png'},
    alt: 'Repeated image',
  })
  const f = await fixture(document)
  await writeFile(
    path.join(f.assets, 'webtransport-guide-cover.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )

  const request = await buildArticleRequest(f.articlePath, {blogRoot: f.blogRoot})
  assert.ok(request.body instanceof FormData)
  assert.equal(request.headers['Content-Type'], undefined)
  assert.equal(request.localAssets.length, 1)
  assert.equal([...request.body.keys()].filter((key) => key === 'article').length, 1)
  assert.equal([...request.body.keys()].filter((key) => key === 'assets').length, 1)
})

test('rejects unsafe, missing, symlinked, excessive, and unreferenced article locations', async (t) => {
  const unsafe = article()
  unsafe.coverImage = {
    source: {path: '../secrets/token.png'},
    alt: {en: 'Unsafe', zh: '不安全'},
  }
  const f = await fixture(unsafe)
  await assert.rejects(
    buildArticleRequest(f.articlePath, {blogRoot: f.blogRoot}),
    (error) => error.code === 'ASSET_PATH_INVALID',
  )

  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'outside-blog-'))
  const outside = path.join(outsideRoot, 'article.json')
  await writeFile(outside, `${JSON.stringify(article())}\n`)
  await assert.rejects(
    buildArticleRequest(outside, {blogRoot: f.blogRoot}),
    (error) => error.code === 'ARTICLE_LOCATION_INVALID',
  )

  t.assert.ok(true)
})

test('structured API errors and malformed responses never expose the token', async () => {
  const f = await fixture()
  const secret = 'do-not-leak-this-token'
  await assert.rejects(
    requestArticle('create', f.articlePath, {
      blogRoot: f.blogRoot,
      token: secret,
      fetchImpl: async () =>
        response(
          {
            error: {
              code: 'SANITY_OPERATION_FAILED',
              message: `malicious echo ${secret}`,
              details: {uploadedAssetIds: ['image-retained-1200x630-png']},
            },
            requestId: 'failed-request',
          },
          502,
        ),
    }),
    (error) => {
      assert.ok(error instanceof PublisherApiError)
      assert.equal(error.statusCode, 502)
      assert.equal(error.code, 'SANITY_OPERATION_FAILED')
      assert.equal(error.requestId, 'failed-request')
      assert.deepEqual(error.uploadedAssetIds, ['image-retained-1200x630-png'])
      assert.doesNotMatch(error.message, new RegExp(secret))
      return true
    },
  )

  await assert.rejects(
    requestArticle('dry-run', f.articlePath, {
      blogRoot: f.blogRoot,
      token: secret,
      fetchImpl: async () => response({unexpected: true}),
    }),
    (error) => error.code === 'API_RESPONSE_INVALID' && !error.message.includes(secret),
  )
})

test('success and error outputs are rebuilt from allowlisted fields and cannot reflect the token', async () => {
  const f = await fixture()
  const secret = 'opaque-reflection-test-token'
  const sanitized = await requestArticle('create', f.articlePath, {
    blogRoot: f.blogRoot,
    token: secret,
    fetchImpl: async () =>
      response(
        {
          data: {
            status: 'published',
            mode: 'created',
            id: 'safe-document-id',
            revision: 'safe-revision',
            slug: 'webtransport-guide',
            uploadedAssetIds: [],
            maliciousEcho: secret,
          },
          requestId: 'safe-request-id',
          maliciousEcho: secret,
        },
        201,
      ),
  })
  assert.deepEqual(Object.keys(sanitized), ['data', 'requestId'])
  assert.deepEqual(Object.keys(sanitized.data), [
    'status',
    'mode',
    'id',
    'revision',
    'slug',
    'uploadedAssetIds',
  ])
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(secret))

  await assert.rejects(
    requestArticle('create', f.articlePath, {
      blogRoot: f.blogRoot,
      token: secret,
      fetchImpl: async () =>
        response(
          {
            data: {
              status: 'published',
              mode: 'created',
              id: 'safe-document-id',
              revision: 'safe-revision',
              slug: 'webtransport-guide',
              uploadedAssetIds: [],
            },
            requestId: secret,
          },
          201,
        ),
    }),
    (error) => error.code === 'API_RESPONSE_INVALID' && !error.message.includes(secret),
  )

  await assert.rejects(
    requestArticle('create', f.articlePath, {
      blogRoot: f.blogRoot,
      token: secret,
      fetchImpl: async () =>
        response(
          {
            error: {
              code: 'SANITY_OPERATION_FAILED',
              message: secret,
              details: {uploadedAssetIds: [secret]},
            },
            requestId: secret,
          },
          502,
        ),
    }),
    (error) =>
      error.code === 'SANITY_OPERATION_FAILED' &&
      error.requestId === undefined &&
      error.uploadedAssetIds.length === 0 &&
      !error.message.includes(secret),
  )
})

test('malformed upstream responses preserve the known HTTP status safely', async () => {
  const f = await fixture()
  for (const [status, body] of [
    [409, ''],
    [429, 'not-json'],
    [502, '{'],
  ]) {
    await assert.rejects(
      requestArticle('dry-run', f.articlePath, {
        blogRoot: f.blogRoot,
        token: 'opaque-test-token',
        fetchImpl: async () => new Response(body, {status}),
      }),
      (error) => error.statusCode === status && error.code === 'API_RESPONSE_INVALID',
    )
  }
})

test('all documented failure statuses remain structured and are never retried', async () => {
  const f = await fixture()
  for (const status of [400, 401, 409, 413, 415, 422, 429, 500, 502]) {
    let attempts = 0
    await assert.rejects(
      requestArticle('create', f.articlePath, {
        blogRoot: f.blogRoot,
        token: 'opaque-test-token',
        fetchImpl: async () => {
          attempts += 1
          return response(
            {
              error: {code: `STATUS_${status}`, message: 'safe upstream description'},
              requestId: `request-${status}`,
            },
            status,
          )
        },
      }),
      (error) =>
        error instanceof PublisherApiError &&
        error.statusCode === status &&
        error.code === `STATUS_${status}` &&
        error.requestId === `request-${status}`,
    )
    assert.equal(attempts, 1)
  }
})

test('asset references stay JSON-only while invalid signatures and excess image counts stop locally', async () => {
  const referenced = article('asset-reference-guide')
  referenced.coverImage = {
    source: {assetRef: 'image-example-1200x630-png'},
    alt: {en: 'Cover', zh: '封面'},
  }
  const jsonFixture = await fixture(referenced)
  const jsonRequest = await buildArticleRequest(jsonFixture.articlePath, {
    blogRoot: jsonFixture.blogRoot,
  })
  assert.equal(jsonRequest.headers['Content-Type'], 'application/json')
  assert.equal(jsonRequest.localAssets.length, 0)

  const disguised = article('disguised-image-guide')
  disguised.coverImage = {
    source: {path: './assets/disguised-image-guide-cover.png'},
    alt: {en: 'Cover', zh: '封面'},
  }
  const badFixture = await fixture(disguised)
  await writeFile(path.join(badFixture.assets, 'disguised-image-guide-cover.png'), 'not a png')
  await assert.rejects(
    buildArticleRequest(badFixture.articlePath, {blogRoot: badFixture.blogRoot}),
    (error) => error.code === 'ASSET_FORMAT_INVALID',
  )

  const excessive = article('excessive-images-guide')
  excessive.body.en = Array.from({length: 11}, (_, index) => ({
    _type: 'image',
    source: {path: `./assets/image-${index}.png`},
    alt: {en: `Image ${index}`, zh: `图片 ${index}`},
  }))
  const excessiveFixture = await fixture(excessive)
  await assert.rejects(
    buildArticleRequest(excessiveFixture.articlePath, {blogRoot: excessiveFixture.blogRoot}),
    (error) => error.code === 'ASSET_COUNT_EXCEEDED',
  )
})

test('a network failure performs exactly one production attempt', async () => {
  const f = await fixture()
  let attempts = 0
  await assert.rejects(
    requestArticle('create', f.articlePath, {
      blogRoot: f.blogRoot,
      token: 'opaque-test-token',
      fetchImpl: async () => {
        attempts += 1
        throw new Error('network down')
      },
    }),
    (error) => error.code === 'NETWORK_RESULT_UNKNOWN',
  )
  assert.equal(attempts, 1)
})
