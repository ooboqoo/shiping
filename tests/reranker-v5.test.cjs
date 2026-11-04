const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs'),
  rows = [
    { id: 'a', text: '概念介绍', revision: 'r1', score: 0.03 },
    { id: 'b', text: '直接答案731', revision: 'r2', score: 0.02 }
  ]
const config = {
  enabled: true,
  url: 'http://127.0.0.1:18200/rerank',
  model: 'BAAI/bge-reranker-v2-m3',
  timeoutMs: 100
}
test('local reranker maps scores by candidate index without overwriting RRF or citations', async () => {
  const { rerankCandidates } = load('src/main/library-v4/reranker.ts')
  const r = await rerankCandidates('问题', rows, config, undefined, async (u, o) => {
    assert.deepEqual(
      JSON.parse(o.body).documents,
      rows.map((h) => h.text)
    )
    return Response.json({
      model: config.model,
      device: 'mps',
      model_hash: 'pinned',
      results: [
        { index: 1, relevance_score: 8 },
        { index: 0, relevance_score: -2 }
      ]
    })
  })
  assert.equal(r.hits[0].id, 'b')
  assert.equal(r.hits[0].revision, 'r2')
  assert.equal(r.hits[0].score, 0.02)
  assert.equal(r.hits[0].rerankScore, 8)
  assert.equal(r.diagnostics.status, 'applied')
})
test('invalid permutations, wrong models and timeouts fall back to the original fusion order', async () => {
  const { rerankCandidates } = load('src/main/library-v4/reranker.ts')
  for (const data of [
    {
      model: config.model,
      results: [
        { index: 0, relevance_score: 1 },
        { index: 0, relevance_score: 2 }
      ]
    },
    {
      model: 'wrong',
      results: [
        { index: 0, relevance_score: 1 },
        { index: 1, relevance_score: 2 }
      ]
    },
    { model: config.model, results: [{ index: 0, relevance_score: 'bad' }] }
  ]) {
    const r = await rerankCandidates('q', rows, config, undefined, async () => Response.json(data))
    assert.deepEqual(r.hits, rows)
    assert.equal(r.diagnostics.status, 'fallback')
  }
  const r = await rerankCandidates(
    'q',
    rows,
    config,
    undefined,
    async (_u, o) =>
      new Promise((_, reject) => {
        o.signal.addEventListener('abort', () => reject(o.signal.reason))
        setTimeout(() => reject(Error('timeout')), 150)
      })
  )
  assert.equal(r.diagnostics.status, 'fallback')
})
test('disabled means no model call and cancellation never silently becomes a successful fallback', async () => {
  const { rerankCandidates, validateRerankConfig } = load('src/main/library-v4/reranker.ts')
  assert.throws(() => validateRerankConfig({ ...config, url: 'https://example.com/rerank' }))
  const off = await rerankCandidates('q', rows, { enabled: false }, undefined, () => {
    throw Error('should not call')
  })
  assert.equal(off.diagnostics.status, 'disabled')
  const c = new AbortController()
  c.abort()
  await assert.rejects(
    rerankCandidates('q', rows, config, c.signal),
    (e) => e.name === 'AbortError'
  )
})
