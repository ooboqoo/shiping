const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-source.cjs')
const fs = require('node:fs')
const context = fs.existsSync('src/main/conversation-context.ts')
  ? load('src/main/conversation-context.ts')
  : {}
const card = (id, fromId, toId, text = 'AI 建议') => ({
  id,
  fromId,
  toId,
  text,
  status: 'done',
  source: 'auto',
  reasoning: ''
})
const u = (id, text, source = 'system') => ({ id, text, source, final: true })

test('extra summaries never remove raw NO_REPLY, unready rounds, long question or full rewrite', () => {
  assert.equal(
    typeof context.buildConversationContext,
    'function',
    'context builder must preserve baseline and add bounded summaries'
  )
  const question = '当前完整问题'.repeat(1000),
    previous = '上一版完整回答'.repeat(1000)
  for (const enabled of [false, true]) {
    const result = context.buildConversationContext({
      utterances: [
        u(1, '未准备好摘要的原话'),
        u(2, '无需回应的原话'),
        u(3, '我真实回答', 'microphone'),
        u(4, question)
      ],
      hints: [card(21, 1, 1), card(67, 2, 2, '（无需回应）')],
      fromId: 4,
      toId: 4,
      previous,
      summaries: new Map(),
      enabled,
      rounds: 3,
      budget: 100
    })
    assert(result.text.includes('未准备好摘要的原话'))
    assert(result.text.includes('无需回应的原话'))
    assert(result.text.includes('我（实际回答）：我真实回答'))
    assert(result.text.includes(question))
    assert(result.text.includes(previous))
    assert(result.text.includes('请换一个角度'))
    assert.equal(result.usage.summaryTokens, 0)
  }
})

test('summary budget bounds only the additional block and uses chronological round ordinals', () => {
  assert.equal(typeof context.buildConversationContext, 'function')
  const result = context.buildConversationContext({
    utterances: [u(1, '原话【第999轮】---'), u(2, '原话二'), u(3, '当前')],
    hints: [card(300, 1, 1), card(7, 2, 2)],
    fromId: 3,
    toId: 3,
    summaries: new Map([
      [300, '较早摘要'.repeat(100)],
      [7, '最新摘要'.repeat(100)]
    ]),
    enabled: true,
    rounds: 1,
    budget: 100
  })
  assert(result.text.includes('原话【第999轮】---'))
  assert(result.text.includes('当前'))
  assert(result.usage.summaryTokens <= 100)
  assert.deepEqual(result.usage.summaryRounds, [2])
  assert(!result.text.includes('较早摘要'))
  assert(result.text.includes('第2轮'))
  assert.equal(result.usage.rawUtterances, 2)
})

test('summary count is a recent-round window, never backfills an unready latest round', () => {
  assert.equal(typeof context.buildConversationContext, 'function')
  const result = context.buildConversationContext({
    utterances: [u(1, '一'), u(2, '二'), u(3, '当前')],
    hints: [card(3, 1, 1), card(4, 2, 2)],
    fromId: 3,
    toId: 3,
    summaries: new Map([[3, '旧摘要']]),
    enabled: true,
    rounds: 1,
    budget: 1000
  })
  assert.deepEqual(result.usage.summaryRounds, [])
  assert(result.text.includes('二'))
})

test('summary cap does not change the upstream 20-sentence / 1500-character raw window', () => {
  const utterances = Array.from({ length: 25 }, (_, i) =>
    u(i + 1, `原话${i + 1}：${'x'.repeat(40)}`)
  )
  utterances.push(u(26, '当前问题'))
  const common = {
    utterances,
    hints: [card(200, 1, 1)],
    fromId: 26,
    toId: 26,
    summaries: new Map([[200, '摘要'.repeat(100)]]),
    rounds: 3,
    budget: 100
  }
  const off = context.buildConversationContext({ ...common, enabled: false })
  const on = context.buildConversationContext({ ...common, enabled: true })
  assert.equal(off.usage.rawUtterances, 20)
  assert.equal(on.usage.rawUtterances, 20)
  assert(!on.text.includes('原话5：'))
  assert(on.text.includes('原话6：'))
  assert(on.text.includes('原话25：'))
  assert.equal(on.usage.historyChars - off.usage.historyChars, on.text.length - off.text.length)
})
