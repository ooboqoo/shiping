const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
function knowledge(writeFails = false, files = new Map()) {
  const handlers = new Map()
  const fs = {
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
    readFileSync: (p) => files.get(p)
  }
  let fail = writeFails
  const k = load('src/main/knowledge.ts', {
    './library-v4/desktop-runtime': { desktopLibrary: undefined },
    electron: {
      app: { getPath: () => '/isolated' },
      dialog: {},
      ipcMain: { handle: (key, fn) => handlers.set(key, fn) }
    },
    fs,
    'fs/promises': {
      writeFile: async (p, t) => {
        if (typeof fail === 'function' ? fail(p) : fail) throw Error('disk full')
        files.set(p, t)
      },
      rename: async (a, b) => {
        files.set(b, files.get(a))
        files.delete(a)
      },
      unlink: async (p) => files.delete(p)
    },
    './knowledge-parse': { normalizeText: (t) => t.trim() }
  })
  return {
    k,
    handlers,
    files,
    fail: (value) => {
      fail = value
    }
  }
}
test('failed knowledge write rejects creation and removes false-success memory', async () => {
  const { k, handlers } = knowledge(true)
  await assert.rejects(handlers.get('knowledge:create')({}, 'test', 'secret'), /disk full/)
  assert.deepEqual(k.getRagDocuments(), [])
})
test('document edits/deletes notify retrieval immediately and successful state is persisted', async () => {
  const { k, handlers } = knowledge()
  let notices = 0
  k.onKnowledgeChanged(() => notices++)
  const doc = await handlers.get('knowledge:create')({}, 'test', 'Redis')
  assert.equal(k.getRagDocuments()[0].text, 'Redis')
  const updated = await handlers.get('knowledge:update')({}, doc.id, {
    text: 'Postgres',
    modes: ['screenshot'],
    version: doc.version
  })
  assert.equal(k.getRagDocuments()[0].text, 'Postgres')
  assert.deepEqual(k.getRagDocuments()[0].modes, ['screenshot'])
  await handlers.get('knowledge:remove')({}, doc.id, updated.version)
  assert.deepEqual(k.getRagDocuments(), [])
  assert.ok(notices >= 3)
})

test('index pointer save failure preserves old disk revision after reload', async () => {
  const x = knowledge()
  const d = await x.handlers.get('knowledge:create')({}, 'test', 'old body')
  x.fail((p) => p.endsWith('index.json.tmp'))
  await assert.rejects(
    x.handlers.get('knowledge:update')({}, d.id, { text: 'new body', version: d.version }),
    /disk full/
  )
  assert.equal(x.k.getRagDocuments()[0].text, 'old body')
  const restart = knowledge(false, x.files)
  assert.equal(restart.k.getRagDocuments()[0].text, 'old body')
})
