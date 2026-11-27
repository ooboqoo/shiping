const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-source.cjs')

const shared = load('src/shared/conversation.ts')

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function harness(t, { settings: extra = {}, onStream, apiKey = 'test' } = {}) {
  const handlers = new Map()
  const requests = []
  const events = []
  let sentence, end, mobile
  const settings = {
    conversationHintMode: 'auto',
    conversationMinChars: 4,
    conversationSilenceMs: 800,
    conversationIgnoreWords: shared.DEFAULT_CONVERSATION_IGNORE_WORDS,
    ...extra
  }
  const api = load('src/main/conversation.ts', {
    electron: {
      app: {
        on() {
          /* unused mock */
        }
      },
      ipcMain: { handle: (k, f) => handlers.set(k, f) }
    },
    './settings': {
      settings,
      getModeProfile: () => ({ apiKey }),
      onSettingsChanged() {
        /* unused mock */
      }
    },
    './save-conversation': {
      saveConversation: async () => {},
      saveConversationSync() {
        /* unused mock */
      }
    },
    './mobile-sync': {
      markMobileDirty() {
        /* unused mock */
      },
      registerMobileSource: (_k, f) => {
        mobile = f
      }
    },
    './transcription': {
      isTranscriptionRunning: () => true,
      onConversationSentence: (f) => {
        sentence = f
      },
      onTranscriptionEnd: (f) => {
        end = f
      },
      onTranscriptionStart() {
        /* unused mock */
      },
      onTranscriptionError() {
        /* unused mock */
      }
    },
    './ai': {
      getHintStream: (messages, signal, query) => {
        const req = { messages, signal, query }
        requests.push(req)
        return { kind: 'hint', req }
      },
      getMemoStream: () => ({ kind: 'memo' }),
      getPrewarmStream: () => ({ kind: 'prewarm' })
    },
    './stream': {
      extractErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
      consumeStream: async (factory, controller, onChunk) => {
        const task = factory(controller.signal)
        if (task.kind === 'memo') return { status: 'complete', text: '备忘' }
        if (onStream) return onStream({ task, controller, onChunk })
        onChunk({ kind: 'text', delta: '直接回答' })
        return { status: 'complete', text: '直接回答' }
      }
    }
  })
  global.mainWindow = { isDestroyed: () => false, webContents: { send: (...x) => events.push(x) } }
  t.after(() => api.clearConversation())
  return {
    api,
    settings,
    requests,
    events,
    say: sentence,
    stop: () => end(),
    snapshot: () => handlers.get('conversation:get-snapshot')(),
    mobile: () => mobile()
  }
}

const flush = () => new Promise((r) => setImmediate(r))

test('countMeaningfulChars counts CJK chars individually and English words as single units', () => {
  assert.equal(shared.countMeaningfulChars('Okay。'), 1)
  assert.equal(shared.countMeaningfulChars('OK!'), 1)
  assert.equal(shared.countMeaningfulChars('Right, yeah.'), 2)
  assert.equal(shared.countMeaningfulChars('What is Redis?'), 3)
  assert.equal(shared.countMeaningfulChars('好的。'), 2)
  assert.equal(shared.countMeaningfulChars('讲一下 Redis 持久化'), 7)
  assert.equal(shared.countMeaningfulChars('...  ！？'), 0)
})

test('parseIgnoreWords and isIgnoredSentence perform normalized whole-sentence matching', () => {
  const defaults = shared.parseIgnoreWords(shared.DEFAULT_CONVERSATION_IGNORE_WORDS)
  for (const filler of ['嗯。', '嗯嗯', 'Okay.', 'OK！', 'RIGHT', '好的，']) {
    assert.equal(shared.isIgnoredSentence(filler, defaults), true, `expected ignored: ${filler}`)
  }
  for (const real of [
    '嗯，那你们怎么保证高可用？',
    'Okay, tell me about Redis',
    '好的，下一个问题'
  ]) {
    assert.equal(shared.isIgnoredSentence(real, defaults), false, `expected kept: ${real}`)
  }

  const custom = shared.parseIgnoreWords('got it; 我懂了，\nうん、네\n行吧')
  assert.equal(shared.isIgnoredSentence('Got it!', custom), true)
  assert.equal(shared.isIgnoredSentence('我懂了。', custom), true)
  assert.equal(shared.isIgnoredSentence('うん。', custom), true)
  assert.equal(shared.isIgnoredSentence('네.', custom), true)
  assert.equal(shared.isIgnoredSentence('行吧', custom), true)
  assert.equal(shared.isIgnoredSentence('行吧，那我们继续', custom), false)
  assert.equal(shared.isIgnoredSentence('嗯。', shared.parseIgnoreWords('')), false)
})

test('isNoReply and maybeNoReply handle variants and streaming prefixes', () => {
  for (const s of ['（无需回应）', '(无需回应)', '无需回应', '  （无需回应）。\n']) {
    assert.equal(shared.isNoReply(s), true)
    assert.equal(shared.maybeNoReply(s), true)
  }
  for (const prefix of ['', '  \n', '（', '（无', '（无需回应', '(无需', '无需']) {
    assert.equal(shared.maybeNoReply(prefix), true)
  }
  for (const answer of [
    '可以用 Redis',
    '（可确认：范围）',
    '无需担心，这里可以这样说',
    '（无需回应）不过可以补充'
  ]) {
    assert.equal(shared.isNoReply(answer), false)
    assert.equal(shared.maybeNoReply(answer), false)
  }
})

test('ignored filler sentences are dropped completely and never trigger or pollute context', async (t) => {
  const h = harness(t)
  // One-shot final filler
  h.say('嗯。', true, 'system')
  // Partial then finalized filler
  h.say('Okay', false, 'system')
  h.say('Okay。', true, 'system')
  // Real question starting with filler is preserved
  h.say('嗯', false, 'system')
  h.say('嗯，那你们怎么保证高可用？', true, 'system')
  await flush()

  assert.deepEqual(
    h.snapshot().utterances.map((u) => u.text),
    ['嗯，那你们怎么保证高可用？']
  )
  assert.equal(h.requests.length, 1)
  assert.doesNotMatch(h.requests[0].messages[0].content, /Okay/)
  assert.equal(h.requests[0].query, '嗯，那你们怎么保证高可用？')
  assert(h.events.some(([ch]) => ch === 'conversation-utterance-removed'))
})

test('ignored filler partial does not interrupt an in-flight automatic hint', async (t) => {
  const gate = deferred()
  const h = harness(t, {
    settings: { conversationMinChars: 1 },
    onStream: async ({ controller, onChunk }) => {
      onChunk({ kind: 'text', delta: '第一步' })
      await gate.promise
      if (controller.signal.aborted) return { status: 'aborted', text: '' }
      onChunk({ kind: 'text', delta: '第二步' })
      return { status: 'complete', text: '第一步第二步' }
    }
  })

  h.say('讲讲线程池原理', true, 'system')
  await flush()
  // Interviewer says "Okay" while the hint is streaming: must not abort it
  h.say('Okay', false, 'system')
  h.say('Okay。', true, 'system')
  gate.resolve()
  await flush()

  assert.equal(h.requests.length, 1)
  assert.equal(h.snapshot().hints.length, 1)
  assert.equal(h.snapshot().hints[0].status, 'done')
  assert.equal(h.snapshot().hints[0].text, '第一步第二步')
})

test('ignore words only filter the other side, not own microphone speech, and drop open fillers on stop', async (t) => {
  const h = harness(t)
  h.say('好的。', true, 'microphone')
  h.say('Okay', false, 'system')
  h.stop()
  await flush()

  assert.deepEqual(
    h.snapshot().utterances.map((u) => [u.source, u.text]),
    [['microphone', '好的。']]
  )
  assert.equal(h.requests.length, 0)
})

test('automatic NO_REPLY hints are buffered silently and never shown on desktop or phone', async (t) => {
  let call = 0
  const h = harness(t, {
    onStream: async ({ onChunk }) => {
      call++
      if (call === 1) {
        onChunk({ kind: 'text', delta: '用主从复制加哨兵' })
        return { status: 'complete', text: '用主从复制加哨兵' }
      }
      if (call === 2) {
        onChunk({ kind: 'reasoning', delta: '这是寒暄，不需要回应' })
        onChunk({ kind: 'text', delta: '（无需' })
        onChunk({ kind: 'text', delta: '回应）' })
        return { status: 'complete', text: '（无需回应）' }
      }
      onChunk({ kind: 'text', delta: '(无需回应)' })
      return { status: 'complete', text: '(无需回应)' }
    }
  })

  h.say('Redis 高可用怎么做？', true, 'system')
  await flush()
  const eventsBefore = h.events.length

  h.say('行吧，我这边先翻一下你简历啊', true, 'system')
  await flush()
  h.say('我看一下第二段经历', true, 'system')
  await flush()

  const hintEventsAfter = h.events
    .slice(eventsBefore)
    .filter(([ch]) => ch.startsWith('conversation-hint'))
  assert.equal(hintEventsAfter.length, 0)
  assert.equal(h.snapshot().hints.length, 1)
  assert.equal(h.snapshot().hints[0].text, '用主从复制加哨兵')
  assert.equal(h.mobile().hints.length, 1)
})

test('automatic hint that starts like NO_REPLY reveals full buffered content once it diverges', async (t) => {
  const step1 = deferred()
  const step2 = deferred()
  const h = harness(t, {
    onStream: async ({ onChunk }) => {
      onChunk({ kind: 'reasoning', delta: '先分析一下' })
      onChunk({ kind: 'text', delta: '（' })
      await step1.promise
      onChunk({ kind: 'text', delta: '可以先确认' })
      await step2.promise
      onChunk({ kind: 'text', delta: '具体场景）' })
      return { status: 'complete', text: '（可以先确认具体场景）' }
    }
  })

  h.say('你们系统吞吐量是多少？', true, 'system')
  await flush()
  // Still matching NO_REPLY prefix: hidden
  assert.equal(h.snapshot().hints.length, 0)
  assert.equal(h.events.filter(([ch]) => ch.startsWith('conversation-hint')).length, 0)

  step1.resolve()
  await flush()
  // Diverged: revealed with buffered text + reasoning
  assert.equal(h.snapshot().hints.length, 1)
  assert.equal(h.snapshot().hints[0].text, '（可以先确认')
  assert.equal(h.snapshot().hints[0].reasoning, '先分析一下')

  step2.resolve()
  await flush()
  assert.equal(h.snapshot().hints[0].status, 'done')
  assert.equal(h.snapshot().hints[0].text, '（可以先确认具体场景）')
})

test('manual requestHint covers utterances skipped by silent NO_REPLY and always shows its result', async (t) => {
  let call = 0
  const h = harness(t, {
    onStream: async ({ onChunk }) => {
      call++
      if (call === 1) {
        onChunk({ kind: 'text', delta: '第一个问题的回答' })
        return { status: 'complete', text: '第一个问题的回答' }
      }
      onChunk({ kind: 'text', delta: '（无需回应）' })
      return { status: 'complete', text: '（无需回应）' }
    }
  })

  h.say('介绍一下你的核心项目', true, 'system')
  await flush()
  h.say('我先看一下你这个指标', true, 'system')
  await flush()
  assert.equal(h.snapshot().hints.length, 1)

  // User manually asks for a hint on the utterance auto-mode dropped
  h.api.requestHint()
  await flush()
  assert.equal(h.requests.length, 3)
  assert.match(h.requests[2].query, /我先看一下你这个指标/)
  // Manual NO_REPLY stays visible so the user gets feedback
  assert.equal(h.snapshot().hints.length, 2)
  assert.equal(h.snapshot().hints[1].source, 'manual')
  assert.equal(h.snapshot().hints[1].text, '（无需回应）')
})

test('manual requestHint reveals an in-flight hidden auto hint; stopHints drops a hidden one cleanly', async (t) => {
  const gate1 = deferred()
  const gate2 = deferred()
  let call = 0
  const h = harness(t, {
    onStream: async ({ controller, onChunk }) => {
      call++
      if (call === 1) {
        await gate1.promise
        if (controller.signal.aborted) return { status: 'aborted', text: '' }
        return { status: 'complete', text: '（无需回应）' }
      }
      onChunk({ kind: 'text', delta: '（无需' })
      await gate2.promise
      onChunk({ kind: 'text', delta: '回应）' })
      return { status: 'complete', text: '（无需回应）' }
    }
  })

  // Case 1: stopHints aborts & drops hidden auto hint without leaving a stopped card
  h.say('我看看这个简历细节', true, 'system')
  await flush()
  assert.equal(h.snapshot().hints.length, 0)
  assert.equal(h.api.stopHints(), true)
  gate1.resolve()
  await flush()
  assert.equal(h.snapshot().hints.length, 0)
  assert.equal(h.events.filter(([ch]) => ch.startsWith('conversation-hint')).length, 0)

  // Case 2: manual requestHint promotes & reveals in-flight hidden auto hint
  h.say('这个地方挺有意思的', true, 'system')
  await flush()
  assert.equal(h.snapshot().hints.length, 0)
  h.api.requestHint()
  assert.equal(h.snapshot().hints.length, 1)
  assert.equal(h.snapshot().hints[0].source, 'manual')
  gate2.resolve()
  await flush()
  assert.equal(h.snapshot().hints.length, 1)
  assert.equal(h.snapshot().hints[0].status, 'done')
})

test('an already-visible waiting card whose auto retry returns NO_REPLY is removed with event', async (t) => {
  const gate = deferred()
  let call = 0
  const h = harness(t, {
    onStream: async ({ controller, onChunk }) => {
      call++
      if (call === 1) {
        onChunk({ kind: 'text', delta: '先答第一句' })
        await gate.promise
        if (controller.signal.aborted) return { status: 'aborted', text: '' }
        return { status: 'complete', text: '先答第一句' }
      }
      onChunk({ kind: 'text', delta: '（无需回应）' })
      return { status: 'complete', text: '（无需回应）' }
    }
  })

  h.say('你先等我一下啊', true, 'system')
  await flush()
  assert.equal(h.snapshot().hints.length, 1)
  // Interviewer keeps talking while card is streaming -> card becomes visible waiting
  h.say('我喝口水先不管刚才那个', false, 'system')
  gate.resolve()
  await flush()
  assert.equal(h.snapshot().hints[0].status, 'waiting')

  // Finalizing restarts card; model answers NO_REPLY -> card removed
  h.say('我喝口水先不管刚才那个', true, 'system')
  await flush()
  assert.equal(h.snapshot().hints.length, 0)
  assert(h.events.some(([ch, id]) => ch === 'conversation-hint-removed' && id === 1))
})

test('auto hint error is revealed even when the card was hidden', async (t) => {
  const h = harness(t, {
    onStream: async () => ({ status: 'failed', error: new Error('network down'), text: '' })
  })
  h.say('讲一下事务隔离级别', true, 'system')
  await flush()
  assert.equal(h.snapshot().hints.length, 1)
  assert.equal(h.snapshot().hints[0].status, 'error')
  assert.match(h.snapshot().hints[0].error, /network down/)
})
