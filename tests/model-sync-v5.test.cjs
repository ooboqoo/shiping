const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
const profile = {
  id: 'd',
  name: 'DeepSeek',
  apiBaseURL: 'https://api.deepseek.com/v1',
  apiKey: 'private-key',
  apiHeaders: 'X-Test: private-header',
  model: 'deepseek-chat',
  disableThinking: true,
  vision: false
}
test('desktop sync waits for a valid conversation profile, whitelists fields and skips unchanged settings', async () => {
  const { ModelSync } = load('src/main/library-v4/model-sync.ts')
  let current = { profile: { ...profile, apiKey: '' }, proxy: { mode: 'system' } },
    sent = []
  const sync = new ModelSync(
    () => current,
    async () => ({ route: 'DIRECT' }),
    async (p, v) => {
      sent.push({ p, v })
      return { source: 'desktop' }
    }
  )
  await sync.flush()
  assert.equal(sent.length, 0)
  current = { ...current, profile }
  await sync.flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].p.apiKey, 'private-key')
  assert.equal(sent[0].p.vision, undefined)
  assert.equal(sent[0].p.id, undefined)
  assert.equal(sent[0].p.proxy.mode, 'direct')
  assert.doesNotMatch(JSON.stringify(sync.status()), /private-key|private-header/)
  await sync.flush()
  assert.equal(sent.length, 1)
  sync.close()
})
test('unsupported proxy never silently bypasses the configured route, failed sync remains safe', async () => {
  const { ModelSync } = load('src/main/library-v4/model-sync.ts')
  let calls = 0
  const sync = new ModelSync(
    () => ({ profile, proxy: { mode: 'system' } }),
    async () => ({ route: 'SOCKS4 127.0.0.1:7890' }),
    async () => {
      calls++
    }
  )
  await sync.flush()
  assert.equal(calls, 0)
  assert.match(sync.status().message, /代理/)
  sync.close()
  const failing = new ModelSync(
    () => ({ profile, proxy: { mode: 'direct' } }),
    async () => ({ route: 'DIRECT' }),
    async () => {
      throw Error('private-key')
    }
  )
  await failing.flush()
  assert.doesNotMatch(JSON.stringify(failing.status()), /private-key/)
  failing.close()
})
test('late proxy resolution from an older profile never overwrites newer settings', async () => {
  const { ModelSync } = load('src/main/library-v4/model-sync.ts')
  let resolve,
    current = { profile, proxy: { mode: 'system' } },
    sent = []
  const sync = new ModelSync(
    () => current,
    () => new Promise((r) => (resolve = r)),
    async (p) => {
      sent.push(p)
    }
  )
  const old = sync.flush()
  current = { profile: { ...profile, model: 'deepseek-new' }, proxy: { mode: 'direct' } }
  sync.notify()
  await sync.flush()
  resolve({ route: 'DIRECT' })
  await old
  assert.equal(sent.length, 1)
  assert.equal(sent[0].model, 'deepseek-new')
  sync.close()
})

test('resolved system HTTP proxy is forwarded as the explicit same proxy, never downgraded to direct', async () => {
  const { ModelSync } = load('src/main/library-v4/model-sync.ts')
  let sent
  const sync = new ModelSync(
    () => ({ profile, proxy: { mode: 'system', url: '' } }),
    async () => ({ route: 'PROXY 127.0.0.1:7897; DIRECT' }),
    async (value) => {
      sent = value
      return { source: 'desktop' }
    }
  )
  await sync.flush()
  assert.deepEqual(sent.proxy, { mode: 'custom', url: 'http://127.0.0.1:7897' })
  assert.equal(sync.status().synced, true)
  sync.close()
})
