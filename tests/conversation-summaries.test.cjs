const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const load = require('./load-source.cjs')
const mod = fs.existsSync('src/main/conversation-summaries.ts')
  ? load('src/main/conversation-summaries.ts')
  : {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('idle summaries run latest first and discard late results after preemption or rewrite', async () => {
  assert.equal(typeof mod.SummaryQueue, 'function')
  const calls = []
  const queue = new mod.SummaryQueue(
    (text, signal) => new Promise((resolve) => calls.push({ text, signal, resolve })),
    { idleMs: 5, timeoutMs: 100 }
  )
  queue.sync([
    { id: 1, text: '旧问答' },
    { id: 2, text: '新问答' }
  ])
  await wait(15)
  assert.equal(calls[0].text, '新问答')
  queue.pause()
  assert(calls[0].signal.aborted)
  calls[0].resolve('已作废摘要')
  await wait(1)
  assert.equal(queue.summaries.size, 0)
  queue.sync([
    { id: 1, text: '旧问答' },
    { id: 2, text: '已重写问答' }
  ])
  await wait(15)
  calls[1].resolve('新摘要')
  await wait(1)
  assert.equal(queue.summaries.get(2), '新摘要')
  queue.sync([{ id: 2, text: '又重写问答' }])
  assert.equal(queue.summaries.has(2), false)
  queue.clear()
})

test('clear fences an ignored abort; timeout releases a provider that never settles', async () => {
  assert.equal(typeof mod.SummaryQueue, 'function')
  const calls = []
  const queue = new mod.SummaryQueue(
    (text, signal) => new Promise((resolve) => calls.push({ text, signal, resolve })),
    { idleMs: 2, timeoutMs: 8 }
  )
  queue.sync([
    { id: 1, text: '一' },
    { id: 2, text: '二' }
  ])
  await wait(100)
  assert.equal(calls.length, 2)
  assert(calls[0].signal.aborted)
  queue.clear()
  calls[1].resolve('不能复活')
  await wait(2)
  assert.equal(queue.summaries.size, 0)
})
