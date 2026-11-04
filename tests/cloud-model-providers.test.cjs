const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
const api = () => load('src/main/library-v4/model-providers.ts')
const cloud = {
  provider: 'siliconflow',
  baseURL: 'https://api.siliconflow.cn/v1/',
  model: 'BAAI/bge-m3',
  apiKey: 'paid-test-key',
  timeoutMs: 1000
}
test('paid providers require a key and secure remote URLs, retaining custom API prefixes', () => {
  const { normalizeModelConfig } = api()
  assert.equal(normalizeModelConfig(cloud).baseURL, 'https://api.siliconflow.cn/v1')
  assert.equal(
    normalizeModelConfig({ ...cloud, baseURL: 'https://api.siliconflow.cn' }).baseURL,
    'https://api.siliconflow.cn/v1'
  )
  assert.equal(
    normalizeModelConfig({
      ...cloud,
      provider: 'openai-compatible',
      baseURL: 'https://host.test/compatible-mode/v1/'
    }).baseURL,
    'https://host.test/compatible-mode/v1'
  )
  assert.throws(() => normalizeModelConfig({ ...cloud, apiKey: '' }), /API Key/)
  assert.throws(() => normalizeModelConfig({ ...cloud, baseURL: 'http://cloud.test/v1' }), /HTTPS/)
  assert.throws(
    () => normalizeModelConfig({ ...cloud, provider: 'openai-compatible' }, 'rerank'),
    /Embedding/
  )
  assert.throws(() => normalizeModelConfig({ ...cloud, provider: 'rerank-compatible' }), /Rerank/)
})
test('cloud embeddings use OpenAI wire format with explicit float response and mapped input order', async () => {
  const { embedModel } = api()
  for (const provider of ['siliconflow', 'openai-compatible']) {
    const vectors = await embedModel(
      { ...cloud, provider },
      ['a', 'b'],
      undefined,
      async (u, o) => {
        assert.equal(u, 'https://api.siliconflow.cn/v1/embeddings')
        assert.equal(o.headers.Authorization, 'Bearer paid-test-key')
        assert.deepEqual(JSON.parse(o.body), {
          model: 'BAAI/bge-m3',
          input: ['a', 'b'],
          encoding_format: 'float'
        })
        return Response.json({
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] }
          ]
        })
      }
    )
    assert.deepEqual(vectors, [
      [1, 2],
      [3, 4]
    ])
  }
})
test('SiliconFlow lists embedding and reranker models with task filters', async () => {
  const { listProviderModels } = api()
  for (const [kind, type] of [
    ['embedding', 'embedding'],
    ['rerank', 'reranker']
  ]) {
    const rows = await listProviderModels(
      cloud,
      undefined,
      async (u) => {
        assert.equal(u, 'https://api.siliconflow.cn/v1/models?sub_type=' + type)
        return Response.json({ data: [{ id: 'model' }] })
      },
      kind
    )
    assert.equal(rows[0].id, 'model')
    assert.equal(rows[0].type, kind)
  }
})
test('paid rerank APIs preserve candidate IDs and scores', async () => {
  const { rerankCandidates } = load('src/main/library-v4/reranker.ts'),
    hits = [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' }
    ]
  for (const provider of ['siliconflow', 'rerank-compatible']) {
    const result = await rerankCandidates(
      'Q',
      hits,
      { ...cloud, provider, enabled: true, model: 'BAAI/bge-reranker-v2-m3' },
      undefined,
      async (u, o) => {
        assert.equal(u, 'https://api.siliconflow.cn/v1/rerank')
        assert.equal(o.headers.Authorization, 'Bearer paid-test-key')
        assert.deepEqual(JSON.parse(o.body), {
          model: 'BAAI/bge-reranker-v2-m3',
          query: 'Q',
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
  }
})
test('paid fingerprint probes once per configuration and never requires a model-list endpoint', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-model-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { ModelProviders } = api()
  let calls = 0
  const p = new ModelProviders(dir, async (u, o) => {
    calls++
    assert.ok(u.endsWith('/embeddings'))
    const n = JSON.parse(o.body).input.length
    return Response.json({
      data: Array.from({ length: n }, (_, index) => ({ index, embedding: [1, 2] }))
    })
  })
  p.configure(cloud)
  assert.equal(calls, 0)
  const fp = await p.io.fingerprint()
  await p.io.fingerprint()
  assert.equal(calls, 1)
  await p.io.embed(['a', 'b'])
  await p.io.fingerprint()
  assert.equal(calls, 2)
  p.configure({ ...cloud, apiKey: undefined })
  assert.equal(p.status().hasApiKey, true)
  assert.ok(!JSON.stringify(p.status()).includes('paid-test-key'))
  assert.equal(await p.io.fingerprint(), fp)
  p.configure({ ...cloud, model: 'other' })
  assert.notEqual(await p.io.fingerprint(), fp)
})
test('paid HTTP errors are actionable and never repeat secret response bodies', async () => {
  const { embedModel } = api()
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      embedModel(cloud, ['a'], undefined, async () => new Response('paid-test-key', { status })),
      (e) => e.message.includes(String(status)) && !e.message.includes('paid-test-key')
    )
})
test('Aliyun uses workspace-root URLs, compatible embeddings and native nested rerank', async () => {
  const { embedModel, normalizeModelConfig, listProviderModels } = api(),
    aliyun = {
      ...cloud,
      provider: 'aliyun',
      baseURL: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'text-embedding-v4'
    }
  assert.equal(
    normalizeModelConfig(aliyun).baseURL,
    'https://workspace.cn-beijing.maas.aliyuncs.com'
  )
  await embedModel(aliyun, ['a'], undefined, async (u) => {
    assert.equal(u, 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings')
    return Response.json({ data: [{ index: 0, embedding: [1, 2] }] })
  })
  const rows = await listProviderModels(
    aliyun,
    undefined,
    () => {
      throw Error('curated list must not call remote')
    },
    'rerank'
  )
  assert.ok(rows.some((r) => r.id === 'qwen3-rerank' && r.source === 'preset'))
  const { rerankCandidates } = load('src/main/library-v4/reranker.ts')
  const result = await rerankCandidates(
    'Q',
    [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' }
    ],
    { ...aliyun, model: 'qwen3-rerank', enabled: true },
    undefined,
    async (u, o) => {
      assert.equal(
        u,
        'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank'
      )
      assert.deepEqual(JSON.parse(o.body), {
        model: 'qwen3-rerank',
        input: { query: 'Q', documents: ['A', 'B'] },
        parameters: { top_n: 2 }
      })
      return Response.json({
        output: {
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.1 }
          ]
        }
      })
    }
  )
  assert.equal(result.diagnostics.status, 'applied')
  assert.equal(result.hits[0].id, 'b')
})
test('a changed cloud dimension invalidates old vectors and gives rebuild a new fingerprint', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-dimension-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { ModelProviders } = api()
  let vector = [1, 2]
  const p = new ModelProviders(dir, async () =>
    Response.json({ data: [{ index: 0, embedding: vector }] })
  )
  p.configure(cloud)
  const fp = await p.io.fingerprint()
  vector = [1, 2, 3]
  await assert.rejects(p.io.embed(['query']), /维度/)
  assert.notEqual(await p.io.fingerprint(), fp)
})
