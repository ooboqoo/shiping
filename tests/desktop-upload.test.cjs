const test = require('node:test'),
  assert = require('node:assert/strict')
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http')
const load = require('./load-source.cjs')
test('desktop streams exact file bytes and reports progress only from writes, waits for receipt', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const bytes = Buffer.alloc(300000, 97),
    file = path.join(dir, 'test.txt')
  await fs.writeFile(file, bytes)
  let received, submission
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/session') {
      res.setHeader('Set-Cookie', 'session=fixture; HttpOnly')
      res.end(JSON.stringify({ csrf: 'csrf' }))
      return
    }
    assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`)
    assert.equal(req.headers['x-rag-csrf'], 'csrf')
    assert.equal(req.headers.cookie, 'session=fixture')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received = Buffer.concat(chunks)
    submission = new URL(req.url, 'http://local').searchParams.get('submission')
    res.statusCode = 202
    res.end(JSON.stringify({ jobId: 'job', docId: 'doc' }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const progress = []
  const { uploadLocalFile } = load('src/main/library-v4/desktop-upload.ts')
  const result = await uploadLocalFile(
    `http://127.0.0.1:${server.address().port}`,
    file,
    'shiping',
    'submission',
    (n) => progress.push(n)
  )
  assert.deepEqual(received, bytes)
  assert.equal(submission, 'submission')
  assert.equal(result.jobId, 'job')
  assert.ok(progress.length > 1)
  assert.equal(progress.at(-1), bytes.length)
  assert.ok(progress.every((n, i) => n > 0 && n <= bytes.length && (!i || n >= progress[i - 1])))
  await assert.rejects(
    uploadLocalFile('http://127.0.0.1:1', path.join(dir, 'bad.exe'), 'shiping', 'x', () => {}),
    /格式|ENOENT/
  )
  await fs.writeFile(path.join(dir, 'empty.txt'), '')
  await assert.rejects(
    uploadLocalFile('http://127.0.0.1:1', path.join(dir, 'empty.txt'), 'shiping', 'x', () => {}),
    /大于0/
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    uploadLocalFile(
      `http://127.0.0.1:${server.address().port}`,
      file,
      'shiping',
      'x',
      () => {},
      controller.signal
    ),
    /abort/i
  )
})

test('lost acknowledgement recovers durable receipt instead of duplicating upload; server failure remains actionable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-receipt-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'test.txt')
  await fs.writeFile(file, 'fixture')
  let accepted = false,
    posts = 0
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/session') {
      res.setHeader('Set-Cookie', 's=1')
      res.end(JSON.stringify({ csrf: 'token' }))
      return
    }
    if (req.method === 'POST') {
      posts++
      for await (const chunk of req) {
      }
      req.socket.destroy()
      return
    }
    res.statusCode = accepted ? 200 : 404
    res.end(
      JSON.stringify(
        accepted ? { jobId: 'durable', docId: 'doc', reused: true } : { error: '尚未接收' }
      )
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { uploadLocalFile } = load('src/main/library-v4/desktop-upload.ts')
  const origin = `http://127.0.0.1:${server.address().port}`
  accepted = true
  assert.equal((await uploadLocalFile(origin, file, 'shiping', 'same', () => {})).jobId, 'durable')
  assert.equal(posts, 1)
  accepted = false
  await assert.rejects(
    uploadLocalFile(origin, file, 'shiping', 'other', () => {}),
    /socket hang up/
  )
})
