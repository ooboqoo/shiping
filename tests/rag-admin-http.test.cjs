const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  load = require('./load-source.cjs')
const { createAdminHandler } = load('src/main/rag/admin-http.ts')
test('bridge rejects missing tokens and foreign Host, and dispatches only known operations', async (t) => {
  const server = http.createServer(
    createAdminHandler({
      token: 'test-secret',
      methods: { list: async () => [{ name: '安全资料' }] }
    })
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const url = `http://127.0.0.1:${server.address().port}`
  assert.equal(
    (
      await fetch(url + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"method":"list"}'
      })
    ).status,
    401
  )
  const foreign = await new Promise((resolve) => {
    const q = http.request(
      url + '/rpc',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-secret',
          Host: 'evil.example',
          'Content-Type': 'application/json'
        }
      },
      (r) => {
        r.resume()
        r.on('end', () => resolve(r.statusCode))
      }
    )
    q.end('{"method":"list"}')
  })
  assert.equal(foreign, 403)
  const ok = await fetch(url + '/rpc', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: '{"method":"list","args":[]}'
  })
  assert.deepEqual(await ok.json(), [{ name: '安全资料' }])
  const bad = await fetch(url + '/rpc', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    body: '{"method":"constructor","args":[]}'
  })
  assert.equal(bad.status, 404)
})
