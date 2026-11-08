const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-source.cjs')

test('new stores leave extra summaries off and preserve explicit choices after restart', () => {
  const saved = new Map()
  global.localStorage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
    removeItem: (k) => saved.delete(k)
  }
  try {
    const { useSettingsStore: store } = load('src/renderer/src/lib/store/settings.ts')
    assert.equal(store.getState().conversationSummaryEnabled, false)
    assert.equal(store.getState().conversationSummaryRounds, 3)
    assert.equal(store.getState().conversationSummaryBudget, 1000)
    store.getState().updateSetting('conversationSummaryEnabled', true)
    store.getState().updateSetting('conversationSummaryRounds', 12)
    store.getState().updateSetting('conversationSummaryBudget', 100)
    const { useSettingsStore: again } = load('src/renderer/src/lib/store/settings.ts')
    assert.equal(again.getState().conversationSummaryEnabled, true)
    assert.equal(again.getState().conversationSummaryRounds, 12)
    assert.equal(again.getState().conversationSummaryBudget, 100)
    again.getState().updateSetting('conversationSummaryEnabled', false)
    const { useSettingsStore: off } = load('src/renderer/src/lib/store/settings.ts')
    assert.equal(off.getState().conversationSummaryEnabled, false)
    assert.equal(off.getState().conversationSummaryRounds, 12)
  } finally {
    delete global.localStorage
  }
})

test('summary requests use only the independent task and proxy-aware transport with output cap', async () => {
  const calls = []
  const profile = {
    apiKey: 'test',
    apiBaseURL: 'https://proxy.example/v1',
    model: 'gpt-5-mini',
    apiHeaders: 'X-Test: demo',
    disableThinking: false
  }
  const { summarizeConversation } = load('src/main/ai.ts', {
    './settings': {
      settings: { conversationPrompt: 'SCENE_DO_NOT_SEND' },
      getModeProfile: () => profile
    },
    './knowledge': {
      getKnowledgePrompt: () => {
        throw Error('summary must not read user knowledge')
      }
    },
    './external-knowledge': {
      getExternalReference: () => {
        throw Error('summary must not retrieve')
      },
      withReference: () => {
        throw Error('summary must not add reference')
      }
    },
    './api-fetch': {
      apiFetch: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) })
        return new Response(JSON.stringify({ choices: [{ message: { content: '简短摘要' } }] }), {
          status: 200
        })
      }
    }
  })
  assert.equal(typeof summarizeConversation, 'function')
  const signal = new AbortController().signal
  assert.equal(
    await summarizeConversation('对方：问题\nAI建议：建议\n我（实际回答）：实话', signal),
    '简短摘要'
  )
  assert.equal(calls[0].url, 'https://proxy.example/v1/chat/completions')
  assert.equal(calls[0].init.signal, signal)
  assert.equal(calls[0].body.max_completion_tokens, 400)
  assert.equal(calls[0].body.max_tokens, undefined)
  assert.equal(calls[0].body.reasoning_effort, 'none')
  assert(!JSON.stringify(calls[0].body).includes('SCENE_DO_NOT_SEND'))
  assert.match(calls[0].body.messages[0].content, /不代表.*实际/)
  profile.model = 'Qwen/Qwen3-32B'
  await summarizeConversation('另一段', signal)
  assert.equal(calls[1].body.max_tokens, 400)
  assert.equal(calls[1].body.enable_thinking, false)
})

test('new stores normalize corrupted summary choices without resetting valid persisted values', () => {
  const saved = new Map()
  global.localStorage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
    removeItem: (k) => saved.delete(k)
  }
  try {
    const { useSettingsStore: store } = load('src/renderer/src/lib/store/settings.ts')
    store.getState().updateSetting('conversationSummaryRounds', 999)
    store.getState().updateSetting('conversationSummaryBudget', 0)
    const { useSettingsStore: again } = load('src/renderer/src/lib/store/settings.ts')
    assert.equal(again.getState().conversationSummaryRounds, 20)
    assert.equal(again.getState().conversationSummaryBudget, 100)
  } finally {
    delete global.localStorage
  }
})

for (const summaryFirst of [true, false]) {
  test(`thinking refusal caches stay isolated when ${summaryFirst ? 'background summary' : 'foreground hint'} runs first`, async (t) => {
    const calls = [],
      notices = []
    const profile = {
      apiKey: 'test',
      apiBaseURL: 'https://isolation.example/v1',
      model: 'Qwen/RejectThinking',
      apiHeaders: '',
      disableThinking: false
    }
    const previousWindow = global.mainWindow
    global.mainWindow = {
      isDestroyed: () => false,
      webContents: { send: (...args) => notices.push(args) }
    }
    t.after(() => {
      global.mainWindow = previousWindow
    })
    const api = load.createLoader({
      './settings': { settings: { conversationPrompt: '正常提示' }, getModeProfile: () => profile },
      './knowledge': { getKnowledgePrompt: () => '' },
      './external-knowledge': {
        getExternalReference: async () => undefined,
        withReference: (messages) => messages
      },
      './api-fetch': {
        apiFetch: async (_url, init) => {
          const body = JSON.parse(init.body)
          calls.push({ body, signal: init.signal })
          if (body.enable_thinking === false)
            return new Response('enable_thinking is unsupported', { status: 400 })
          if (!body.stream)
            return new Response(JSON.stringify({ choices: [{ message: { content: '摘要' } }] }), {
              status: 200
            })
          const event = {
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: profile.model,
            choices: [{ index: 0, delta: { content: '前台回答' }, finish_reason: null }]
          }
          const finish = { ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
          return new Response(
            `data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
      }
    })('src/main/ai.ts')
    const signal = new AbortController().signal
    const summary = async () =>
      assert.equal(await api.summarizeConversation('待摘要内容', signal), '摘要')
    const foreground = async () => {
      profile.disableThinking = true
      let answer = ''
      for await (const chunk of api.getHintStream([{ role: 'user', content: '前台问题' }], signal))
        if (chunk.kind === 'text') answer += chunk.delta
      assert.equal(answer, '前台回答')
    }
    if (summaryFirst) {
      await summary()
      assert.deepEqual(notices, [])
      await foreground()
    } else {
      await foreground()
      await summary()
    }
    assert.deepEqual(
      calls.slice(0, 4).map(({ body }) => [Boolean(body.stream), body.enable_thinking]),
      summaryFirst
        ? [
            [false, false],
            [false, undefined],
            [true, false],
            [true, undefined]
          ]
        : [
            [true, false],
            [true, undefined],
            [false, false],
            [false, undefined]
          ]
    )
    assert.deepEqual(notices, [['thinking-unsupported', 'Qwen/RejectThinking']])
    await summary()
    await foreground()
    assert.equal(calls.length, 6)
    assert.equal(calls[4].body.enable_thinking, undefined)
    assert.equal(calls[5].body.enable_thinking, undefined)
    assert.equal(notices.length, 1)
    assert(calls.every((call) => call.signal === signal))
  })
}
