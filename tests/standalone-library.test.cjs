const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  sync = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  load = require('./load-source.cjs')
const entry = path.resolve(__dirname, '../out/main/library-service.cjs')
test(
  'fresh managed library uploads before configuration, resumes embedding and survives restart without external services',
  { skip: !sync.existsSync(entry) },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-library-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    let modelCalls = 0
    const model = http.createServer(async (req, res) => {
      let body = ''
      for await (const p of req) body += p
      const input = JSON.parse(body).input
      modelCalls++
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }))
    })
    await new Promise((r) => model.listen(0, '127.0.0.1', r))
    t.after(() => new Promise((r) => model.close(r)))
    const { ManagedLibrary } = load('src/main/library-v4/managed.ts'),
      { DesktopLibrary } = load('src/main/library-v4/desktop-client.ts'),
      options = {
        root,
        entry,
        publicDir: path.resolve(__dirname, '../resources/library-web'),
        ocrDir: path.resolve(__dirname, '../resources/ocr')
      }
    let manager = new ManagedLibrary(options)
    t.after(() => manager.stop())
    const discovery = path.join(root, 'data/library/service.json')
    let client = new DesktopLibrary(discovery, async () => {
      await manager.ready()
    })
    async function until(read, predicate) {
      const end = Date.now() + 20000
      while (Date.now() < end) {
        const v = await read()
        if (predicate(v)) return v
        await new Promise((r) => setTimeout(r, 50))
      }
      throw Error('condition timed out')
    }
    await manager.ready()
    assert.equal((await client.call('runtimeStatus', [])).storage, 'sqlite-vectors')
    assert.equal((await client.call('providerStatus', [])).embedding.configured, false)
    assert.equal((await client.call('providerStatus', [])).rerank.configured, false)
    const file = path.join(root, '测试资料.txt')
    await fs.writeFile(file, '项目代号是青松8642，负责人是林雨。')
    const submission = require('node:crypto').randomUUID()
    const progress = []
    const receipt = await client.upload(file, submission, (loaded, total) => progress.push({loaded, total}))
    assert.ok(receipt.jobId)
    assert.equal(progress.at(-1).loaded, (await fs.stat(file)).size)
    const reused = await client.upload(file, submission, () => {})
    assert.equal(reused.jobId, receipt.jobId)
    assert.equal(reused.docId, receipt.docId)
    await until(
      () => client.call('tasks', ['shiping']),
      (rows) =>
        rows.some((j) => j.kind === 'ingest' && j.status === 'done') &&
        rows.some((j) => j.kind === 'index' && j.status === 'queued')
    )
    assert.equal(modelCalls, 0)
    assert.match((await client.call('status', ['shiping'])).message, /配置.*模型/)
    await client.call('configureProvider', [
      'embedding',
      {
        provider: 'siliconflow',
        baseURL: 'http://127.0.0.1:' + model.address().port + '/v1',
        model: 'test-embedding',
        apiKey: 'test-only-key'
      }
    ])
    await until(
      () => client.call('status', ['shiping']),
      (s) => s.state === 'ready'
    )
    assert.ok(modelCalls > 0)
    let answer = await client.call('searchDetails', ['shiping', '青松8642', 'conversation'])
    assert.ok(answer.context.includes('青松8642'))
    const docs = await client.call('list', ['shiping'])
    assert.equal(docs.length, 1)
    await manager.stop()
    manager = new ManagedLibrary(options)
    client = new DesktopLibrary(discovery, async () => {
      await manager.ready()
    })
    await manager.ready()
    assert.equal((await client.call('list', ['shiping'])).length, 1)
    answer = await client.call('searchDetails', ['shiping', '青松8642', 'conversation'])
    assert.ok(answer.context.includes('青松8642'))
    assert.equal((await client.call('providerStatus', [])).embedding.hasApiKey, true)
  }
)
