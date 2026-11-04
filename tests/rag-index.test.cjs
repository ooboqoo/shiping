const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
const { RagIndex } = load('src/main/rag/index.ts')
function setup() {
  let saved,
    calls = 0
  const records = new Map()
  const io = {
    fingerprint: async () => 'model:1024:v1',
    embed: async (xs) => {
      calls++
      return xs.map(() => [1, 0])
    },
    upsert: async (cs) => cs.forEach((c) => records.set(c.id, c)),
    query: async () => [...records.values()].map((c) => ({ ...c, name: 'n', score: 0.9 })),
    remove: async (ids) => ids.forEach((id) => records.delete(id)),
    save: async (s) => {
      saved = structuredClone(s)
    },
    load: () => saved
  }
  const i = new RagIndex(io)
  return { i, io, records, calls: () => calls }
}
const doc = (id, text, modes = ['conversation']) => ({
  id,
  name: id,
  text,
  modes,
  revision: require('node:crypto').createHash('sha256').update(text).digest('hex')
})
test('unchanged docs reuse embeddings; updated/deleted/disabled records are excluded', async () => {
  const { i, calls } = setup()
  const a = doc('a', 'Redis 项目优化')
  await i.reconcile([a])
  const n = calls()
  await i.reconcile([a])
  assert.equal(calls(), n)
  assert.equal((await i.retrieve('conversation', 'Redis'))[0].docId, 'a')
  i.setDocuments([])
  assert.deepEqual(await i.retrieve('conversation', 'Redis'), [])
  i.setDocuments([{ ...a, modes: [] }])
  assert.deepEqual(await i.retrieve('conversation', 'Redis'), [])
})
test('failed persistence cannot report ready and stale data cannot answer', async () => {
  const { i, io } = setup()
  io.save = async () => {
    throw Error('disk full')
  }
  await assert.rejects(i.reconcile([doc('a', 'Redis')]), /disk full/)
  assert.equal(i.getStatus().state, 'error')
  await assert.rejects(i.retrieve('conversation', 'Redis'))
})
test('deleted document is not resurrected by a slow indexing job', async () => {
  const { i, io } = setup()
  let release
  io.embed = () =>
    new Promise((r) => {
      release = r
    })
  const p = i.reconcile([doc('a', 'Redis')])
  await new Promise((r) => setImmediate(r))
  i.setDocuments([])
  release([[1, 0]])
  await p
  assert.deepEqual(await i.retrieve('conversation', 'Redis'), [])
})
test('model change blocks old index; abort prevents query', async () => {
  const { i, io } = setup()
  await i.reconcile([doc('a', 'Redis')])
  io.fingerprint = async () => 'changed'
  await assert.rejects(i.retrieve('conversation', 'Redis'), /模型/)
  const c = new AbortController()
  c.abort()
  await assert.rejects(i.retrieve('conversation', 'Redis', c.signal))
})

test('deleted documents also remove newly written physical vectors', async () => {
  const { i, io, records } = setup()
  const original = io.upsert
  io.upsert = async (cs, vs) => {
    await original(cs, vs)
    i.setDocuments([])
  }
  await i.reconcile([doc('a', 'Redis')])
  assert.equal(records.size, 0)
})
test('explicit rebuild reembeds unchanged documents after backend data loss', async () => {
  const { i, calls, records } = setup()
  const d = doc('a', 'Redis')
  await i.reconcile([d])
  const n = calls()
  records.clear()
  await i.reconcile([d], true)
  assert.ok(calls() > n)
  assert.equal(records.size, 1)
})

test('failed obsolete cleanup never deletes committed active vectors', async () => {
  const { i, io, records } = setup()
  await i.reconcile([doc('a', 'old')])
  const original = io.remove
  let once = true
  io.remove = async (ids) => {
    if (once) {
      once = false
      throw Error('temporary cleanup failure')
    }
    await original(ids)
  }
  await assert.rejects(i.reconcile([doc('a', 'new')]), /cleanup/)
  assert.ok([...records.values()].some((c) => c.text === 'new'))
  assert.ok((await i.retrieve('conversation', 'new')).some((h) => h.text === 'new'))
})
test('corrupt saved metadata reports error and explicit rebuild can recover', async () => {
  const { io } = setup()
  io.load = () => ({})
  const x = new RagIndex(io)
  assert.equal(x.getStatus().state, 'error')
  await x.reconcile([doc('a', 'Redis')], true)
  assert.equal(x.getStatus().state, 'ready')
})
test('restart reports the persisted index instead of claiming it is missing', async () => {
  const { i, io } = setup()
  await i.reconcile([doc('a', 'Redis')])
  const restarted = new RagIndex(io)
  restarted.setDocuments([doc('a', 'Redis')])
  assert.equal(restarted.getStatus().state, 'ready')
  assert.equal(restarted.getStatus().chunks, 1)
})
