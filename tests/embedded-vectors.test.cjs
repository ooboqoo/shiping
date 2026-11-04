const test = require('node:test'),
  assert = require('node:assert/strict')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const load = require('./load-source.cjs')
const BASE =
  'http://127.0.0.1:18000/api/v2/tenants/default_tenant/databases/default_database/collections'
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-vectors-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { EmbeddedVectorStore } = load('src/main/library-v4/vector-store.ts')
  const store = new EmbeddedVectorStore(path.join(dir, 'vectors.sqlite'))
  t.after(() => store.close())
  return { store, dir, request: store.request }
}
test('local collections persist float32 vectors, filter ids and rank by cosine', async (t) => {
  const { store, dir, request } = setup(t)
  const c = await request(BASE, { name: 'collection' })
  await request(`${BASE}/${c.id}/upsert`, {
    ids: ['a', 'b', 'c'],
    embeddings: [
      [1, 0],
      [0, 1],
      [-1, 0]
    ],
    documents: ['A', 'B', 'C'],
    metadatas: [{ inputHash: 'a' }, { inputHash: 'b' }, {}]
  })
  const q = await request(`${BASE}/collection/query`, {
    query_embeddings: [[1, 0]],
    ids: ['b', 'a'],
    n_results: 1
  })
  assert.deepEqual(q.ids, [['a']])
  assert.deepEqual(q.distances, [[0]])
  assert.deepEqual((await request(`${BASE}/${c.id}/get`, { ids: ['b'] })).documents, ['B'])
  store.close()
  const { EmbeddedVectorStore } = load('src/main/library-v4/vector-store.ts')
  const reopened = new EmbeddedVectorStore(path.join(dir, 'vectors.sqlite'))
  t.after(() => reopened.close())
  assert.equal((await reopened.request(`${BASE}/collection`)).id, c.id)
  await reopened.request(`${BASE}/collection/delete`, { ids: ['a'] })
  assert.deepEqual((await reopened.request(`${BASE}/collection/get`, { ids: ['a', 'b'] })).ids, [
    'b'
  ])
  await reopened.request(`${BASE}/collection`, undefined, undefined, 'DELETE')
  await assert.rejects(reopened.request(`${BASE}/collection`), /HTTP 404/)
})
test('invalid dimension, float32 overflow and nonfinite batches never partially upsert', async (t) => {
  const { request } = setup(t)
  await request(BASE, { name: 'c' })
  await request(`${BASE}/c/upsert`, { ids: ['a'], embeddings: [[1, 0]] })
  for (const vector of [[1], [Infinity, 0], [1e100, 0], [0, 0]]) {
    await assert.rejects(
      request(`${BASE}/c/upsert`, { ids: ['b', 'c'], embeddings: [[0, 1], vector] })
    )
    assert.deepEqual((await request(`${BASE}/c/get`, {})).ids, ['a'])
  }
  await assert.rejects(
    request(`${BASE}/c/query`, { query_embeddings: [[1]], n_results: 1 }),
    /维度/
  )
  await assert.rejects(request('http://external.invalid/anything'), /本地向量/)
})
test('query yields and observes abort before returning a result', async (t) => {
  const { request } = setup(t)
  await request(BASE, { name: 'c' })
  await request(`${BASE}/c/upsert`, {
    ids: Array.from({ length: 2500 }, (_, i) => String(i)),
    embeddings: Array.from({ length: 2500 }, () => [1, 0])
  })
  const controller = new AbortController()
  const pending = request(
    `${BASE}/c/query`,
    { query_embeddings: [[1, 0]], n_results: 3 },
    controller.signal
  )
  setImmediate(() => controller.abort())
  await assert.rejects(pending, /abort/i)
})
test('migration restores historical collections only from matching cached input hashes and fingerprints', async (t) => {
  const { store, dir, request } = setup(t)
  const { Catalog } = load('src/main/library-v4/catalog.ts'),
    catalog = new Catalog(path.join(dir, 'catalog.sqlite'))
  t.after(() => catalog.close())
  catalog.project('p', 'P')
  const chunks = [
    { id: 'a', vectorKey: 'a', inputHash: 'hash', text: '资料', docId: 'd' },
    { id: 'b', vectorKey: 'b', inputHash: 'missing', text: '未缓存', docId: 'd' }
  ]
  const id = catalog.createGeneration('p', 'historical', 'model:2:v1', [], chunks)
  catalog.cacheVector('model:2:v1', 'hash', [1, 0])
  catalog.cacheVector('other', 'missing', [0, 1])
  store.migrate(catalog)
  assert.deepEqual(store.migrationStatus(), { restored: 1, missing: 1 })
  assert.equal((await request(`${BASE}/historical`)).name, 'historical')
  const found = await request(`${BASE}/historical/get`, { ids: ['a', 'b'] })
  assert.deepEqual(found.ids, ['a'])
  assert.equal(found.metadatas[0].fingerprint, 'model:2:v1')
  assert.equal(catalog.generation('p', id).chunks.length, 2)
  // Migration must not resurrect records that were subsequently removed locally.
  await request(`${BASE}/historical/delete`, { ids: ['a'] })
  store.migrate(catalog)
  assert.deepEqual((await request(`${BASE}/historical/get`, {})).ids, [])
})
function serviceSetup(t, configured = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-vector-service-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const actual = load('src/main/library-v4/model-providers.ts')
  let calls = 0
  class Providers {
    isConfigured() {
      return configured
    }
    configure() {
      configured = true
    }
    status() {
      return { provider: 'openai-compatible' }
    }
    io = {
      request: async () => {
        throw Error('unexpected HTTP vector request')
      },
      fingerprint: async () => 'test:model:2:structure-v2',
      embed: async (inputs) => {
        calls += inputs.length
        return inputs.map(() => [1, 0])
      }
    }
  }
  const { LibraryService } = load('src/main/library-v4/service.ts', {
    './model-providers': { ...actual, ModelProviders: Providers }
  })
  const service = new LibraryService(dir)
  t.after(() => service.close())
  return { service, dir, calls: () => calls }
}
test('service default storage indexes and permanently deletes without a vector HTTP request', async (t) => {
  const { service: s, dir } = serviceSetup(t)
  assert.deepEqual(s.runtimeStatus(), {
    version: 1,
    storage: 'sqlite-vectors',
    migration: { restored: 0, missing: 0 }
  })
  const p = s.createProject('P')
  s.catalog.create(p.id, { name: '资料', text: '资料\n', modes: ['conversation'] })
  s.scheduleIndex(p.id)
  await s.drain()
  assert.equal(s.status(p.id).state, 'ready')
  assert.ok(fs.existsSync(path.join(dir, 'vectors.sqlite')))
  const c = s.catalog.generation(p.id).collection
  s.projectTrash(p.id, s.catalog.projectInfo(p.id).version)
  const preview = s.purgePreview(p.id)
  assert.equal((await s.purge(p.id, { version: preview.version, confirm: true })).deleted, true)
  await assert.rejects(s.io.request(`${BASE}/${c}`), /404/)
})
test('unconfigured service queues indexing until model setup and reports waiting status', async (t) => {
  const { service: s, calls } = serviceSetup(t, false)
  const p = s.createProject('P')
  s.catalog.create(p.id, { name: '资料', text: '资料\n', modes: ['conversation'] })
  s.scheduleIndex(p.id)
  await s.drain()
  assert.equal(calls(), 0)
  assert.match(s.status(p.id).message, /配置.*模型/)
  assert.equal(s.catalog.tasks(p.id).find((x) => x.kind === 'index').status, 'queued')
  s.configureProvider('embedding', {})
  await s.drain()
  assert.equal(s.status(p.id).state, 'ready')
  assert.ok(calls() > 0)
})
test('service disables legacy local reranking and requires a configured rerank provider', async (t) => {
  const { service: s } = serviceSetup(t)
  assert.throws(() => s.configureRetrieval(true), /请先在AI模型配置精排模型/)
  assert.throws(
    () => s.configureProvider('rerank', { provider: 'local' }),
    /请先在AI模型配置精排模型/
  )
  await assert.rejects(s.testProvider('rerank', { provider: 'local' }), /请先在AI模型配置精排模型/)
})
test('migration refuses cache vectors whose dimension disagrees with their model fingerprint', async (t) => {
  const { store, dir, request } = setup(t)
  const { Catalog } = load('src/main/library-v4/catalog.ts'),
    c = new Catalog(path.join(dir, 'catalog.sqlite'))
  t.after(() => c.close())
  c.project('p', 'P')
  c.createGeneration(
    'p',
    'bad-cache',
    'model:3:v1',
    [],
    [{ id: 'a', vectorKey: 'a', inputHash: 'hash', docId: 'd' }]
  )
  c.cacheVector('model:3:v1', 'hash', [1, 0])
  store.migrate(c)
  assert.deepEqual((await request(`${BASE}/bad-cache/get`, {})).ids, [])
})

test('active collection missing vectors is reported until a cache-only repair completes', async (t) => {
  const { service: s, calls } = serviceSetup(t)
  const p = s.createProject('P')
  s.catalog.create(p.id, { name: '资料', text: '资料\n', modes: ['conversation'] })
  s.scheduleIndex(p.id)
  await s.drain()
  const generation = s.catalog.generation(p.id),
    before = calls()
  await s.io.request(`${BASE}/${generation.collection}/delete`, {
    ids: [generation.chunks[0].vectorKey]
  })
  assert.match(s.status(p.id).message, /向量.*不完整.*重建/)
  s.scheduleIndex(p.id)
  await s.drain()
  assert.equal(calls(), before)
  assert.doesNotMatch(s.status(p.id).message, /不完整/)
})
test('legacy generations without v4 vector keys remain readable and report missing vectors', (t) => {
  const { store, dir } = setup(t),
    { Catalog } = load('src/main/library-v4/catalog.ts'),
    c = new Catalog(path.join(dir, 'legacy.sqlite'))
  t.after(() => c.close())
  c.project('p', 'P')
  const id = c.createGeneration(
    'p',
    'legacy-v2',
    'old-fingerprint',
    [],
    [
      { id: 'old-one', text: '旧资料1' },
      { id: 'old-two', text: '旧资料2' }
    ]
  )
  assert.doesNotThrow(() => store.migrate(c))
  assert.equal(store.migrationStatus().missing, 2)
  assert.equal(store.coverage(c.generation('p', id)).missing, 2)
})
