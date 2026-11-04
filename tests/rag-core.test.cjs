const test = require('node:test'),
  assert = require('node:assert/strict')
const load = require('./load-source.cjs'),
  core = load('src/main/rag/chunks.ts')
test('chunks cover Chinese text with bounded length and overlap', () => {
  const text = '项目优化数据库响应速度。'.repeat(200),
    cs = core.chunkDocument('a', text)
  assert.ok(cs.length > 1)
  assert.equal(cs[0].start, 0)
  assert.equal(cs.at(-1).end, text.length)
  for (let i = 0; i < cs.length; i++) {
    assert.ok(cs[i].text.length <= 1200)
    assert.equal(cs[i].text, text.slice(cs[i].start, cs[i].end))
    if (i) {
      assert.ok(cs[i].start <= cs[i - 1].end)
      assert.ok(cs[i].start >= cs[i - 1].end - 100)
    }
  }
  assert.deepEqual(core.chunkDocument('a', '  '), [])
})
test('hybrid rank retains English project match and discards unrelated content', () => {
  const hit = (id, text, score) => ({
    id,
    docId: id,
    revision: 'v',
    text,
    start: 0,
    end: text.length,
    name: id,
    score
  })
  const hits = core.rankHits(
    'ProjectBeacon Redis',
    [hit('other', '种植番茄', 0.1), hit('b', 'ProjectBeacon 使用 Redis 缓存', 0.6)],
    []
  )
  assert.equal(hits[0].docId, 'b')
  assert.equal(hits.length, 1)
})
test('context deduplicates, quotes sources and obeys total character budget', () => {
  const hs = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    docId: String(i),
    revision: 'v',
    name: 'x'.repeat(100),
    text: 'a'.repeat(1200),
    start: 0,
    end: 1200,
    score: 0.8
  }))
  const result = core.formatContext([...hs, hs[0]])
  assert.ok(result.length <= 6000)
  assert.ok((result.match(/<资料 /g) || []).length <= 6)
  assert.ok(result.includes('来源'))
})
test('invalid vectors are rejected and valid cosine works', () => {
  for (const v of [[NaN], [Infinity], [0, 0], []]) assert.throws(() => core.validateVector(v))
  assert.equal(core.cosine([1, 0], [1, 0]), 1)
  assert.throws(() => core.cosine([1], [1, 2]))
})

test('specific teacher name outranks generic course words and keeps its URL', () => {
  const hit = (id, text, score) => ({
    id,
    docId: 'doc',
    revision: 'v',
    text,
    start: 0,
    end: text.length,
    name: '课程资料',
    score
  })
  const generic = Array.from({ length: 12 }, (_, i) =>
    hit('generic' + i, '老师课程介绍：这份课程资料包含学习路线和课程说明。', 0.65 - i * 0.005)
  )
  const target = hit(
    'target',
    '爬爬虾老师讲解视频：https://www.youtube.com/watch?v=example123',
    0.43
  )
  const hs = core.rankHits('爬爬老师课程网址是什么', generic, [...generic, target])
  assert.equal(hs[0].id, 'target')
  assert.ok(core.formatContext(hs).includes('watch?v=example123'))
})

test('BM25 identifies rare names even without teacher suffix', () => {
  const hit = (id, text, score) => ({
    id,
    docId: 'doc',
    revision: 'v',
    text,
    start: 0,
    end: text.length,
    name: '课程资料',
    score
  })
  const generic = Array.from({ length: 12 }, (_, i) =>
    hit('generic' + i, '课程讲解视频学习资料地址与网址：如何学习课程。', 0.65 - i * 0.005)
  )
  const target = hit('target', '爬爬虾讲解 MCP 的参考视频 https://example.org/mcp', 0.41)
  const hs = core.rankHits('爬爬虾讲MCP的视频链接是什么', generic, [...generic, target])
  assert.equal(hs[0].id, 'target')
})

test('exact matches survive BM25 scoring in a single-chunk library', () => {
  for (const [query, text] of [
    ['MCP', 'MCP'],
    ['爬爬', '爬爬老师课程']
  ]) {
    const h = {
      id: 'one',
      docId: 'doc',
      revision: 'v',
      text,
      start: 0,
      end: text.length,
      name: '资料',
      score: 0.43
    }
    assert.equal(core.rankHits(query, [h], [h])[0]?.id, 'one')
  }
})
