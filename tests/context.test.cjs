const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./voice-load-source.cjs')()

test('history selects last three completed rounds and never leaks unfinished or current answers', () => {
  const { buildHistory } = load('src/shared/conversation-context.ts')
  const hints = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    fromId: i + 1,
    toId: i + 1,
    status: 'done',
    text: 'DO NOT SEND RAW ANSWER'
  }))
  const summaries = new Map(hints.map((h) => [h.id, 'key-' + h.id]))
  assert.equal(
    buildHistory({ hints, utterances: [], summaries, fromId: 6 }),
    '【第 3 轮摘要】\nkey-3\n\n【第 4 轮摘要】\nkey-4\n\n【第 5 轮摘要】\nkey-5'
  )
  hints[4].status = 'streaming'
  assert(!buildHistory({ hints, utterances: [], summaries, fromId: 6 }).includes('key-5'))
  assert(!buildHistory({ hints, utterances: [], summaries, fromId: 4 }).includes('key-4'))
})

test('disabled context, zero rounds, and unready summaries send no history', () => {
  const { buildHistory } = load('src/shared/conversation-context.ts')
  const base = {
    hints: [{ id: 1, fromId: 1, toId: 1, status: 'done', text: 'SECRET' }],
    utterances: [],
    summaries: new Map([[1, 'SECRET']]),
    fromId: 2
  }
  assert.equal(buildHistory({ ...base, enabled: false }), '')
  assert.equal(buildHistory({ ...base, rounds: 0 }), '')
  assert.equal(buildHistory({ ...base, summaries: new Map() }), '')
})

test('history stays within estimated budget and labels actual self speech separately', () => {
  const { buildHistory } = load('src/shared/conversation-context.ts')
  const { estimateTokens } = load('src/shared/knowledge.ts')
  const history = buildHistory({
    hints: [{ id: 1, fromId: 1, toId: 1, status: 'done', text: 'suggestion' }],
    summaries: new Map([[1, 'AI 建议：采用缓存。'.repeat(500)]]),
    utterances: [{ id: 2, source: 'microphone', text: '我实际采用数据库索引。', final: true }],
    fromId: 3,
    tokenBudget: 120
  })
  assert(estimateTokens(history) <= 120)
  assert(history.includes('我的实际发言'))
  assert(history.includes('数据库索引'))
})

test('invalid persisted options normalize without turning false back on', () => {
  const { normalizeContextOptions } = load('src/shared/conversation-context.ts')
  assert.deepEqual(normalizeContextOptions({}), { enabled: true, rounds: 3, tokenBudget: 1000 })
  assert.deepEqual(normalizeContextOptions({ enabled: false, rounds: -1, tokenBudget: NaN }), {
    enabled: false,
    rounds: 0,
    tokenBudget: 1000
  })
})

test('self speech inside an interleaved question range remains associated with that round', () => {
  const { buildHistory } = load('src/shared/conversation-context.ts')
  const text = buildHistory({
    hints: [{ id: 1, fromId: 1, toId: 3, status: 'done', text: 'suggestion' }],
    summaries: new Map([[1, 'AI建议：缓存。']]),
    utterances: [
      { id: 1, source: 'system', text: '问题前半段', final: true },
      { id: 2, source: 'microphone', text: '实际回答：数据库索引', final: true },
      { id: 3, source: 'system', text: '问题后半段', final: true }
    ],
    fromId: 4
  })
  assert(text.includes('数据库索引'))
})

test('background summary preempts immediately, resumes pending work and discards stale clear results', async () => {
  const { SummaryQueue } = load('src/main/conversation-summaries.ts')
  const calls = []
  const queue = new SummaryQueue(
    (input, signal) => new Promise((resolve) => calls.push({ input, signal, resolve })),
    0
  )
  queue.enqueue(1, 'question and answer')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(calls.length, 1)
  queue.pause()
  assert(calls[0].signal.aborted)
  calls[0].resolve('stale aborted summary')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(queue.summaries.size, 0)
  queue.resume()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(calls.length, 2)
  queue.clear()
  calls[1].resolve('stale cleared summary')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(queue.summaries.size, 0)
})
