const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  load = require('./load-source.cjs')
test('web reconcile waits for desktop clear, then writes fresh active vectors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-clear-race-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const rows = new Map(),
    doc = {
      id: 'a',
      name: 'source',
      text: '本地知识',
      modes: ['conversation'],
      revision: require('node:crypto').createHash('sha256').update('本地知识').digest('hex')
    }
  let releaseDelete, startedDelete
  const entered = new Promise((r) => {
    startedDelete = r
  })
  const svc = load('src/main/rag/service.ts', {
    electron: { app: { getPath: () => root } },
    '../settings': { settings: { ragConfig: { mode: 'local' } } },
    '../knowledge': {
      getRagDocuments: () => [doc],
      getKnowledgePrompt: () => '',
      onKnowledgeChanged: () => {}
    },
    './client': {
      fingerprint: async () => 'model:v2',
      embed: async (ts) => ts.map(() => [1, 0]),
      upsert: async (cs) => cs.forEach((c) => rows.set(c.id, c)),
      remove: async (ids) => ids.forEach((id) => rows.delete(id)),
      searchVectors: async () => [],
      clearProjectIndex: () => {
        startedDelete()
        return new Promise((r) => {
          releaseDelete = () => {
            rows.clear()
            r()
          }
        })
      }
    }
  })
  await svc.rebuild()
  const clearing = svc.clear()
  await entered
  await svc.queueReconcile(true)
  assert.equal(svc.getRagStatus().state, 'indexing')
  assert.notEqual(
    svc.getIndex().getStatus().state,
    'indexing',
    'reconcile must not start while collection deletion is pending'
  )
  releaseDelete()
  await clearing
  for (let i = 0; i < 200 && (svc.getRagStatus().state === 'indexing' || rows.size === 0); i++)
    await new Promise((r) => setTimeout(r, 5))
  assert.equal(svc.getRagStatus().state, 'ready')
  assert.equal(rows.size, 1)
})
