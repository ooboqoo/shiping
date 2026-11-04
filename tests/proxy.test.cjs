const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const load = require('./load-source.cjs')

test('proxy settings default to system; custom URLs are normalized and validated', () => {
  const { normalizeProxySettings, modelsURL } = load('src/shared/proxy.ts')
  assert.deepEqual(normalizeProxySettings(undefined), { mode: 'system', url: '' })
  assert.deepEqual(normalizeProxySettings({ mode: 'custom', url: ' HTTP://localhost:20808/ ' }), {
    mode: 'custom',
    url: 'http://localhost:20808'
  })
  for (const url of [
    'socks5://127.0.0.1:20808',
    'http://[::1]:20808',
    'https://proxy.example:443'
  ]) {
    assert.equal(normalizeProxySettings({ mode: 'custom', url }).mode, 'custom')
  }
  for (const url of [
    '',
    '127.0.0.1:20808',
    'ftp://localhost:21',
    'http://user:secret@localhost:20808',
    'http://localhost:99999',
    'http://localhost:20808/path',
    'http://localhost:20808?x=y',
    'http://localhost:20808#fragment',
    'http://localhost:20808;DIRECT'
  ]) {
    assert.throws(() => normalizeProxySettings({ mode: 'custom', url }), /代理/)
  }
  assert.throws(() => normalizeProxySettings({ mode: 'typo' }), /代理/)
  assert.equal(modelsURL(''), 'https://api.openai.com/v1/models')
  assert.equal(modelsURL(' https://example.com/v1/// '), 'https://example.com/v1/models')
  assert.throws(() => modelsURL('file:///secret'), /API/)
  assert.throws(() => modelsURL('https://user:secret@example.com/v1'), /API/)
})

function fixture() {
  const sessions = [],
    calls = []
  const electron = {
    session: {
      fromPartition: (partition, options) => {
        const item = {
          partition,
          options,
          config: null,
          async setProxy(config) {
            this.config = config
          },
          async resolveProxy() {
            return this.config.mode === 'direct' ? 'DIRECT' : 'PROXY localhost:20808'
          },
          async fetch(input, init) {
            calls.push({ session: this, input, init })
            return new Response('{}')
          }
        }
        sessions.push(item)
        return item
      }
    }
  }
  return { sessions, calls, proxy: load('src/main/proxy.ts', { electron }) }
}

test('system, direct and custom use isolated sessions; draft tests cannot change live requests', async () => {
  const { sessions, calls, proxy } = fixture()
  const custom = { mode: 'custom', url: 'http://localhost:20808' }
  const abort = new AbortController()
  await proxy.fetchWithProxy(custom, 'https://api.example/v1', { signal: abort.signal })
  await proxy.fetchWithProxy({ mode: 'direct' }, 'https://api.example/v1')
  await proxy.fetchWithProxy(
    { mode: 'custom', url: 'socks5://localhost:20809' },
    'https://api.example/v1'
  )
  await proxy.fetchWithProxy(custom, 'https://api.example/v1')
  await proxy.fetchWithProxy(undefined, 'https://api.example/v1')
  assert.equal(sessions.length, 4)
  assert.equal(calls[0].init.signal, abort.signal)
  assert.equal(calls[0].session, calls[3].session)
  assert.deepEqual(
    sessions.map((s) => s.config.mode),
    ['fixed_servers', 'direct', 'fixed_servers', 'system']
  )
  assert.equal(sessions[0].config.proxyRules, 'http://localhost:20808')
  assert.equal(sessions[2].config.proxyRules, 'socks5://localhost:20809')
  assert.ok(sessions.every((s) => !s.partition.startsWith('persist:') && s.options.cache === false))
})

test('HTTP responses distinguish connectivity from API errors, without returning response bodies', async () => {
  const { sessions, proxy } = fixture()
  const ses = await proxy.getProxySession({ mode: 'direct' })
  for (const status of [200, 401, 403, 404, 407, 500]) {
    ses.fetch = async () => new Response('secret-response-body', { status })
    const result = await proxy.testProxyConnection(
      { mode: 'direct' },
      { apiBaseURL: 'https://example.com/v1' }
    )
    assert.equal(result.reachable, true)
    assert.equal(result.ok, status === 200)
    assert.equal(result.status, status)
    assert.ok(!JSON.stringify(result).includes('secret-response-body'))
    assert.equal(typeof result.elapsedMs, 'number')
  }
  assert.equal(sessions.length, 1)
})

test('failed proxy setup and fetch errors never fall back to a direct request or expose secrets', async () => {
  const { proxy } = fixture()
  const ses = await proxy.getProxySession({ mode: 'custom', url: 'http://localhost:1' })
  ses.fetch = async () => {
    throw Error('secret-api-key net::ERR_PROXY_CONNECTION_FAILED')
  }
  const result = await proxy.testProxyConnection({ mode: 'custom', url: 'http://localhost:1' }, {})
  assert.equal(result.reachable, false)
  assert.match(result.message, /代理/)
  assert.ok(!JSON.stringify(result).includes('secret-api-key'))
  await assert.rejects(() =>
    proxy.fetchWithProxy({ mode: 'custom', url: 'bad' }, 'https://example.com')
  )
})

test('Chromium network errors are explained, other errors pass through', () => {
  const { extractErrorMessage } = load('src/main/stream.ts')
  assert.match(
    extractErrorMessage(new Error('net::ERR_PROXY_CONNECTION_FAILED')),
    /^代理连接失败.*网络代理.*（net::ERR_PROXY_CONNECTION_FAILED）$/
  )
  assert.match(extractErrorMessage(new Error('net::ERR_CONNECTION_REFUSED')), /^无法连接到 AI 接口/)
  assert.equal(extractErrorMessage(new Error('Incorrect API key')), 'Incorrect API key')
})

test('thinking-off fallback uses the supplied transport and preserves cancellation', async () => {
  const { createThinkingOffFetch } = load('src/main/thinking.ts')
  const calls = [],
    refused = [],
    abort = new AbortController()
  const transport = async (input, init) => {
    calls.push({ input, init })
    return calls.length === 1
      ? new Response('unsupported reasoning', { status: 400 })
      : new Response('{}')
  }
  const fetch = createThinkingOffFetch(
    'https://example.com',
    (model) => refused.push(model),
    transport
  )
  const body = JSON.stringify({ model: 'gpt-proxy-test', messages: [] })
  await fetch('https://example.com', { method: 'POST', body, signal: abort.signal })
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[0].init.body).reasoning_effort, 'none')
  assert.equal(calls[1].init.body, body)
  assert.ok(calls.every((c) => c.init.signal === abort.signal))
  assert.deepEqual(refused, ['gpt-proxy-test'])
})

test('both chat modes and thinking-off requests use the same API transport', async () => {
  const sent = [],
    streams = []
  const transport = async (input, init) => {
    sent.push({ input, init })
    return new Response('{}')
  }
  const profile = {
    id: 'fixture',
    apiBaseURL: 'https://example.com/v1',
    apiKey: '',
    model: 'gpt-fixture',
    disableThinking: false
  }
  const ai = load('src/main/ai.ts', {
    './settings': {
      settings: {},
      getModeProfile: (mode) => ({ ...profile, disableThinking: mode === 'conversation' })
    },
    './rag/service': { getRagContext: async () => '' },
    './api-fetch': { apiFetch: transport },
    ai: {
      streamText: (options) => {
        streams.push(options)
        return { fullStream: [] }
      }
    },
    '@ai-sdk/openai-compatible': {
      createOpenAICompatible: (options) => ({ chatModel: () => options })
    }
  })
  const abort = new AbortController()
  for await (const chunk of ai.getSolutionStream([], abort.signal)) void chunk
  for await (const chunk of ai.getHintStream([], abort.signal)) void chunk
  assert.equal(streams.length, 2)
  for (const options of streams) {
    assert.equal(options.abortSignal, abort.signal)
    await options.model.fetch('https://example.com', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-fixture', messages: [] }),
      signal: abort.signal
    })
  }
  assert.equal(sent.length, 2)
  assert.ok(sent.every((call) => call.init.signal === abort.signal))
  assert.equal(JSON.parse(sent[1].init.body).reasoning_effort, 'none')
})

test('model list requests use the configured API transport', async () => {
  let handler,
    called = false
  load('src/main/model-list.ts', {
    electron: {
      ipcMain: {
        handle: (_channel, fn) => {
          handler = fn
        }
      }
    },
    './api-fetch': {
      apiFetch: async () => {
        called = true
        return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
      }
    }
  })
  const result = await handler(null, 'https://example.com/v1', '')
  assert.equal(called, true)
  assert.equal(result.models[0].id, 'fixture-model')
})

test('old settings default to system proxy and custom settings survive a restart', () => {
  const saved = new Map([
    [
      'interview-coder-settings',
      JSON.stringify({
        version: 8,
        state: { apiKey: 'fixture-existing-key', apiBaseURL: 'https://example.com/v1' }
      })
    ]
  ])
  global.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key)
  }
  const prompts = Object.fromEntries(
    fs
      .readdirSync(path.join(__dirname, '../src/renderer/src/lib/store/prompts'))
      .map((name) => [`./prompts/${name}?raw`, 'fixture prompt'])
  )
  try {
    const { useSettingsStore: store } = load('src/renderer/src/lib/store/settings.ts', prompts)
    assert.deepEqual(store.getState().networkProxy, { mode: 'system', url: '' })
    assert.equal(store.getState().apiKey, 'fixture-existing-key')
    const custom = { mode: 'custom', url: 'socks5://127.0.0.1:20808' }
    store.getState().updateSetting('networkProxy', custom)
    const { useSettingsStore: restarted } = load('src/renderer/src/lib/store/settings.ts', prompts)
    assert.deepEqual(restarted.getState().networkProxy, custom)
    assert.equal(restarted.getState().apiKey, 'fixture-existing-key')
  } finally {
    delete global.localStorage
  }
})
