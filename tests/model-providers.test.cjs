const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
const api = () => load('src/main/library-v4/model-providers.ts')
const xin = {
  provider: 'xinference',
  baseURL: 'http://localhost:9997/v1/',
  model: 'embed-uid',
  apiKey: 'test-secret',
  timeoutMs: 1000
}
test('provider config normalizes /v1 and rejects invalid config and Ollama reranking', () => {
  const { normalizeModelConfig } = api()
  assert.equal(normalizeModelConfig(xin).baseURL, 'http://localhost:9997')
  for (const change of [
    { provider: 'unknown' },
    { baseURL: 'file:///tmp/a' },
    { baseURL: 'http://u:p@localhost' },
    { timeoutMs: NaN },
    { model: '' }
  ])
    assert.throws(() => normalizeModelConfig({ ...xin, ...change }))
  assert.throws(() => normalizeModelConfig({ ...xin, provider: 'ollama' }, 'rerank'), /Ollama/)
})
test('Xinference embeddings recover input order and use optional Bearer', async () => {
  const { embedModel } = api()
  const vectors = await embedModel(xin, ['a', 'b'], undefined, async (u, o) => {
    assert.equal(u, 'http://localhost:9997/v1/embeddings')
    assert.equal(o.headers.Authorization, 'Bearer test-secret')
    assert.deepEqual(JSON.parse(o.body), { model: 'embed-uid', input: ['a', 'b'] })
    return Response.json({
      data: [
        { index: 1, embedding: [3, 4] },
        { index: 0, embedding: [1, 2] }
      ]
    })
  })
  assert.deepEqual(vectors, [
    [1, 2],
    [3, 4]
  ])
})
test('malformed embeddings fail rather than corrupt indexes', async () => {
  const { embedModel } = api()
  for (const data of [
    [],
    [
      { index: 0, embedding: [1, 2] },
      { index: 0, embedding: [3, 4] }
    ],
    [{ embedding: [1, 2] }, { index: 1, embedding: [3, 4] }],
    [
      { index: 0, embedding: [1, 2] },
      { index: 1, embedding: [3] }
    ]
  ])
    await assert.rejects(
      embedModel(xin, ['a', 'b'], undefined, async () => Response.json({ data }))
    )
})
test('Ollama native embeddings and model list use native endpoints', async () => {
  const { embedModel, listProviderModels } = api(),
    config = { ...xin, provider: 'ollama', baseURL: 'http://localhost:11434', apiKey: '' }
  await embedModel(config, ['a'], undefined, async (u, o) => {
    assert.ok(u.endsWith('/api/embed'))
    assert.equal(o.headers.Authorization, undefined)
    assert.equal(JSON.parse(o.body).truncate, false)
    return Response.json({ embeddings: [[1, 2]] })
  })
  const rows = await listProviderModels(config, undefined, async () =>
    Response.json({ models: [{ name: 'bge-m3:latest', digest: 'hash' }] })
  )
  assert.equal(rows[0].id, 'bge-m3:latest')
})
test('HTTP errors redact remote bodies and cancellation propagates', async () => {
  const { embedModel } = api()
  await assert.rejects(
    embedModel(xin, ['a'], undefined, async () => new Response('test-secret', { status: 401 })),
    (e) => /401/.test(e.message) && !e.message.includes('test-secret')
  )
  const c = new AbortController()
  c.abort()
  await assert.rejects(embedModel(xin, ['a'], c.signal), { name: 'AbortError' })
})
test('Xinference rerank sends model UID/top_n and maps scores without requiring model in response', async () => {
  const { rerankCandidates } = load('src/main/library-v4/reranker.ts')
  const rows = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' }
  ]
  const result = await rerankCandidates(
    'q',
    rows,
    { enabled: true, ...xin },
    undefined,
    async (u, o) => {
      assert.equal(u, 'http://localhost:9997/v1/rerank')
      assert.equal(o.headers.Authorization, 'Bearer test-secret')
      assert.deepEqual(JSON.parse(o.body), {
        model: 'embed-uid',
        query: 'q',
        documents: ['A', 'B'],
        top_n: 2
      })
      return Response.json({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 }
        ]
      })
    }
  )
  assert.equal(result.diagnostics.status, 'applied')
  assert.equal(result.hits[0].id, 'b')
  const bad = await rerankCandidates('q', rows, { enabled: true, ...xin }, undefined, async () =>
    Response.json({
      results: [
        { index: 0, relevance_score: 1 },
        { index: 0, relevance_score: 2 }
      ]
    })
  )
  assert.equal(bad.diagnostics.status, 'fallback')
  assert.deepEqual(bad.hits, rows)
})
test('provider config persists privately; endpoint/model changes invalidate fingerprint', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { ModelProviders } = api(),
    transport = async (u) =>
      Response.json(
        u.endsWith('/models')
          ? { data: [{ id: 'embed-uid' }, { id: 'second' }] }
          : { data: [{ index: 0, embedding: [1, 2] }] }
      )
  const p = new ModelProviders(dir, transport)
  p.configure(xin)
  assert.ok(!JSON.stringify(p.status()).includes('test-secret'))
  assert.equal(p.status().hasApiKey, true)
  const before = await p.io.fingerprint()
  p.configure({ ...xin, model: 'second', apiKey: undefined })
  assert.notEqual(await p.io.fingerprint(), before)
  const copy = new ModelProviders(dir, transport)
  assert.equal(copy.status().model, 'second')
  assert.equal(copy.status().hasApiKey, true)
  assert.equal(fs.statSync(path.join(dir, 'embedding-provider.json')).mode & 0o777, 0o600)
})
test('fingerprint ignores floating point inference noise but tracks dimension', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-fp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { ModelProviders } = api()
  let vector = [1, 2]
  const p = new ModelProviders(dir, async (u) =>
    Response.json(
      u.endsWith('/models')
        ? { data: [{ id: 'embed-uid', model_revision: 'r1' }] }
        : { data: [{ index: 0, embedding: vector }] }
    )
  )
  p.configure(xin)
  const first = await p.io.fingerprint()
  vector = [1.0000001, 2]
  assert.equal(await p.io.fingerprint(), first)
  vector = [1, 2, 3]
  assert.notEqual(await p.io.fingerprint(), first)
})
test('switching provider between fingerprint and query embedding cannot query old vectors', async () => {
  const { Retriever } = load('src/main/library-v4/retrieval.ts'),
    { digest } = load('src/main/library-v4/markdown.ts')
  const doc = { id: 'd', text: 'facts', textHash: digest('facts'), name: 'doc' },
    chunk = {
      id: 'c',
      docId: 'd',
      vectorKey: 'v',
      revision: doc.textHash,
      text: doc.text,
      input: doc.text,
      tokenCount: 1,
      start: 0,
      end: 5,
      section: ''
    }
  let fp = 'old',
    queries = 0
  const catalog = {
    projectInfo: () => ({}),
    generation: () => ({ id: 'g', fingerprint: 'old', collection: 'coll', chunks: [chunk] }),
    generationInfo: () => ({}),
    activeDocuments: () => [doc],
    postings: () => []
  }
  const io = {
    fingerprint: async () => fp,
    embed: async () => {
      fp = 'new'
      return [[1]]
    },
    request: async (u) => {
      if (u.endsWith('/query')) {
        queries++
        return { ids: [['v']], distances: [[0.1]] }
      }
      return { id: 'coll' }
    }
  }
  await new Retriever(catalog, io).retrieve('p', 'query', 'conversation')
  assert.equal(queries, 0)
})
