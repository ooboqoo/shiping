const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  load = require('./load-source.cjs')
async function server(t, handler) {
  const s = http.createServer(handler)
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => s.close(r)))
  return s
}
test('backend HTTP proxy receives selected destination and headers, streams without direct fallback', async (t) => {
  let calls = 0
  const proxy = await server(t, async (req, res) => {
    calls++
    assert.equal(req.url, 'http://127.0.0.1:9/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer fake-private')
    let body = ''
    for await (const b of req) body += b
    assert.equal(JSON.parse(body).message, '测试')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: one\n\n')
    res.end('data: two\n\n')
  })
  const { backendFetch } = load('src/main/library-v4/backend-fetch.ts'),
    transport = backendFetch({ mode: 'custom', url: 'http://127.0.0.1:' + proxy.address().port })
  const r = await transport('http://127.0.0.1:9/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-private', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '测试' })
  })
  assert.match(await r.text(), /two/)
  assert.equal(calls, 1)
})
test('HTTPS proxy rejects CONNECT denial and preserves pre-aborted signals', async (t) => {
  let connect = 0
  const proxy = await server(t, (_req, res) => {
    res.writeHead(500)
    res.end()
  })
  proxy.on('connect', (req, socket) => {
    connect++
    assert.equal(req.url, '127.0.0.1:1')
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  const { backendFetch } = load('src/main/library-v4/backend-fetch.ts'),
    transport = backendFetch({ mode: 'custom', url: 'http://127.0.0.1:' + proxy.address().port })
  const r = await transport('https://127.0.0.1:1/v1', { signal: AbortSignal.timeout(1000) })
  assert.equal(r.status, 403)
  assert.equal(connect, 1)
  const c = new AbortController()
  c.abort()
  await assert.rejects(
    transport('https://127.0.0.1:1/v1', { signal: c.signal }),
    (e) => e.name === 'AbortError'
  )
})
test('proxy request errors do not leak credentials and unsupported routes fail closed', async () => {
  const { backendFetch, proxyFromRoute } = load('src/main/library-v4/backend-fetch.ts')
  assert.deepEqual(proxyFromRoute('PROXY 127.0.0.1:7897; DIRECT'), {
    mode: 'custom',
    url: 'http://127.0.0.1:7897'
  })
  assert.deepEqual(proxyFromRoute('DIRECT'), { mode: 'direct', url: '' })
  assert.throws(() => proxyFromRoute('SOCKS4 127.0.0.1:9'))
  await assert.rejects(
    backendFetch({ mode: 'custom', url: 'http://127.0.0.1:1' })('https://model.example/v1', {
      headers: { Authorization: 'Bearer fake-private' },
      signal: AbortSignal.timeout(1000)
    }),
    (e) => !/fake-private/.test(e.message)
  )
})

test('abort during CONNECT immediately rejects and destroys the still-pending proxy socket', async (t) => {
  const net = require('node:net')
  let incoming, received
  const seen = new Promise((r) => (received = r)),
    proxy = net.createServer((socket) => {
      incoming = socket
      socket.on('data', () => received())
    })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  t.after(
    () =>
      new Promise((r) => {
        incoming?.destroy()
        proxy.close(r)
      })
  )
  const { backendFetch } = load('src/main/library-v4/backend-fetch.ts'),
    controller = new AbortController(),
    work = backendFetch({ mode: 'custom', url: 'http://127.0.0.1:' + proxy.address().port })(
      'https://model.example/v1',
      { signal: controller.signal }
    ).then(
      () => ({ resolved: true }),
      (e) => ({ error: e.name })
    )
  await seen
  controller.abort()
  const result = await Promise.race([
    work,
    new Promise((r) => setTimeout(() => r({ pending: true }), 200))
  ])
  await new Promise((r) => setTimeout(r, 30))
  const closed = incoming.destroyed
  incoming.destroy()
  assert.equal(result.pending, undefined)
  assert.equal(result.error, 'AbortError')
  assert.equal(closed, true)
})

test('real TLS tunnel rejects untrusted certificates and streams with an explicitly trusted fixture CA', async (t) => {
  const https = require('node:https'),
    net = require('node:net'),
    fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    { execFileSync } = require('node:child_process'),
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-proxy-tls-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const config = path.join(folder, 'openssl.cnf'),
    key = path.join(folder, 'key.pem'),
    cert = path.join(folder, 'cert.pem')
  fs.writeFileSync(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      config
    ],
    { stdio: 'ignore' }
  )
  let originCalls = 0,
    connects = 0
  const sockets = new Set(),
    origin = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (req, res) => {
        originCalls++
        assert.equal(req.headers.authorization, 'Bearer fixture-private')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: 中文\n\n')
        res.end('data: 完成\n\n')
      }
    )
  origin.on('tlsClientError', () => {})
  await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  const proxy = http.createServer()
  proxy.on('connect', (req, client, head) => {
    connects++
    assert.equal(req.url, 'localhost:' + origin.address().port)
    assert.equal(req.headers.authorization, undefined)
    sockets.add(client)
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    sockets.add(upstream)
    client.on('error', () => {})
    upstream.on('error', () => client.destroy())
    client.on('close', () => {
      upstream.destroy()
      sockets.delete(client)
    })
    upstream.on('close', () => {
      client.destroy()
      sockets.delete(upstream)
    })
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  t.after(
    () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy()
        proxy.close(() => origin.close(r))
      })
  )
  const value = { mode: 'custom', url: 'http://127.0.0.1:' + proxy.address().port },
    url = 'https://localhost:' + origin.address().port + '/stream',
    options = {
      headers: { Authorization: 'Bearer fixture-private' },
      signal: AbortSignal.timeout(3000)
    }
  const { backendFetch } = load('src/main/library-v4/backend-fetch.ts')
  await assert.rejects(backendFetch(value)(url, options), /代理连接失败/)
  assert.equal(originCalls, 0)
  const trusted = load('src/main/library-v4/backend-fetch.ts', {
    'node:https': {
      request: (target, opts, cb) =>
        https.request(target, { ...opts, ca: fs.readFileSync(cert) }, cb)
    }
  })
  const response = await trusted.backendFetch(value)(url, options)
  assert.match(await response.text(), /中文[\s\S]*完成/)
  assert.equal(originCalls, 1)
  assert.equal(connects, 2)
})
