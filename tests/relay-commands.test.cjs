const { test } = require('node:test')
const assert = require('node:assert/strict')
const { WebSocket } = require('ws')

const FILES = { '/': { body: '<!doctype html>', type: 'text/html' } }
const KEY = 'relay-commands-test-key'

/** A relay on an ephemeral port, with the host key the app would send */
async function startRelay(t, options = {}) {
  const { createRelay, deriveViewerToken } = await import('../relay/relay.mjs')
  const relay = createRelay({
    files: FILES,
    viewerToken: deriveViewerToken(KEY),
    hostKey: KEY,
    ...options
  })
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
  t.after(() => relay.close())
  const { port } = relay.server.address()
  return { relay, base: `ws://127.0.0.1:${port}`, token: deriveViewerToken(KEY) }
}

function connect(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/**
 * Reads a socket through a queue, so a message that arrives before the test
 * gets around to it is not lost
 */
function reader(ws) {
  const queue = []
  const waiters = []
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      return new Promise((resolve) => waiters.push(resolve))
    },
    async until(match) {
      for (;;) {
        const message = await this.next()
        if (match(message)) return message
      }
    }
  }
}

async function hostOf(t, base) {
  const host = await connect(`${base}/host`, { Authorization: `Bearer ${KEY}` })
  t.after(() => host.close())
  return host
}

async function viewerOf(t, base, token) {
  const viewer = await connect(`${base}/view?t=${token}`)
  t.after(() => viewer.close())
  return viewer
}

test('a viewer command reaches the host and its answer comes back to that viewer', async (t) => {
  const { base, token } = await startRelay(t)
  const host = await hostOf(t, base)
  const hostReader = reader(host)
  const guest = await viewerOf(t, base, token)
  const guestReader = reader(guest)

  // Who is watching, before anything is asked
  await hostReader.until((m) => m.type === 'viewers' && m.count === 1)
  guest.send(JSON.stringify({ type: 'command', id: 7, action: 'screenshot' }))

  const forwarded = await hostReader.until((m) => m.type === 'command')
  assert.equal(forwarded.action, 'screenshot')
  assert.equal(typeof forwarded.rid, 'number')

  host.send(
    JSON.stringify({ type: 'command-result', rid: forwarded.rid, ok: true, message: '已截图' })
  )
  const answer = await guestReader.until((m) => m.type === 'command-result')
  assert.deepEqual(answer, { type: 'command-result', id: 7, ok: true, message: '已截图' })
})

test('only the listed actions get through', async (t) => {
  const { base, token } = await startRelay(t)
  await hostOf(t, base)
  const guest = await viewerOf(t, base, token)
  const guestReader = reader(guest)

  guest.send(JSON.stringify({ type: 'command', id: 1, action: 'deleteEverything' }))
  const answer = await guestReader.until((m) => m.type === 'command-result')
  assert.equal(answer.ok, false)
  assert.equal(answer.message, '不认识的操作')
})

test('with no app connected the command is refused at once', async (t) => {
  const { base, token } = await startRelay(t)
  const guest = await viewerOf(t, base, token)
  const guestReader = reader(guest)

  guest.send(JSON.stringify({ type: 'command', id: 2, action: 'stop' }))
  const answer = await guestReader.until((m) => m.type === 'command-result')
  assert.deepEqual(answer, { type: 'command-result', id: 2, ok: false, message: '电脑不在线' })
})

test('局域网 runs the command in the relay, where the app is the host', async (t) => {
  /** @type {string[]} */
  const seen = []
  const { base, token } = await startRelay(t, {
    hostKey: '',
    onCommand: (action) => {
      seen.push(action)
      return { ok: true, message: `done:${action}` }
    }
  })
  const guest = await viewerOf(t, base, token)
  const guestReader = reader(guest)

  guest.send(JSON.stringify({ type: 'command', id: 3, action: 'pageDown' }))
  const answer = await guestReader.until((m) => m.type === 'command-result')
  assert.deepEqual(answer, { type: 'command-result', id: 3, ok: true, message: 'done:pageDown' })
  assert.deepEqual(seen, ['pageDown'])
})

test('two commands in the same instant are not both run', async (t) => {
  const { base, token } = await startRelay(t, {
    hostKey: '',
    onCommand: async () => ({ ok: true })
  })
  const guest = await viewerOf(t, base, token)
  const guestReader = reader(guest)

  guest.send(JSON.stringify({ type: 'command', id: 4, action: 'screenshot' }))
  guest.send(JSON.stringify({ type: 'command', id: 5, action: 'stop' }))
  const first = await guestReader.until((m) => m.type === 'command-result')
  const second = await guestReader.until((m) => m.type === 'command-result')
  assert.equal(first.id, 4)
  assert.equal(first.ok, true)
  assert.equal(second.id, 5)
  assert.equal(second.ok, false)
  assert.equal(second.message, '操作太快，请稍后再试')
})

test('an app that disconnects mid-command does not leave the phone waiting', async (t) => {
  const { base, token } = await startRelay(t)
  const host = await hostOf(t, base)
  const hostReader = reader(host)
  const guest = await viewerOf(t, base, token)
  const guestReader = reader(guest)
  await hostReader.until((m) => m.type === 'viewers' && m.count === 1)

  guest.send(JSON.stringify({ type: 'command', id: 6, action: 'append' }))
  await hostReader.until((m) => m.type === 'command')
  host.close()

  const answer = await guestReader.until((m) => m.type === 'command-result')
  assert.deepEqual(answer, { type: 'command-result', id: 6, ok: false, message: '电脑已断开' })
})

test('a viewer cannot write the state other phones read', async (t) => {
  const { base, token } = await startRelay(t)
  await hostOf(t, base)
  const guest = await viewerOf(t, base, token)
  const other = await viewerOf(t, base, token)
  const otherReader = reader(other)

  guest.send(JSON.stringify({ type: 'state', data: { v: 1, mode: 'screenshot' } }))
  const seen = await Promise.race([
    otherReader.until((m) => m.type === 'state').then(() => 'state'),
    new Promise((resolve) => setTimeout(() => resolve('nothing'), 300))
  ])
  assert.equal(seen, 'nothing')
})
