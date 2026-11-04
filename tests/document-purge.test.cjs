const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  load = require('./load-source.cjs')
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-purge-')),
    collections = new Map()
  let fail = false
  const io = {
    fingerprint: async () => 'fixture:3:v2',
    embed: async (xs) => xs.map(() => [1, 2, 3]),
    request: async (url, body) => {
      if (body?.name) {
        collections.set(body.name, new Map())
        return { id: body.name }
      }
      const parts = url.split('/'),
        operation = parts.at(-1),
        name = ['get', 'upsert', 'delete'].includes(operation) ? parts.at(-2) : operation
      const rows = collections.get(name)
      if (!rows) throw Error('HTTP 404')
      if (operation === 'delete') {
        if (fail) throw Error('vectors offline')
        for (const id of body.ids) rows.delete(id)
        return {}
      }
      if (operation === 'upsert') {
        body.ids.forEach((id, i) => rows.set(id, body.metadatas[i]))
        return {}
      }
      if (operation === 'get') {
        const ids = body.ids.filter((id) => rows.has(id))
        return { ids, metadatas: ids.map((id) => rows.get(id)) }
      }
      return { id: name }
    }
  }
  const { LibraryService } = load('src/main/library-v4/service.ts'),
    service = new LibraryService(root, { io, ai: { status: () => ({ configured: false }) } })
  service.catalog.project('p', 'P')
  t.after(async () => {
    await service.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const db = service.catalog,
    a = db.create('p', {
      name: 'target',
      text: '# Shared\n\nCOMMON8642\n\n# Unique\n\nSECRET731\n',
      modes: ['conversation']
    }),
    b = db.create('p', { name: 'keep', text: '# Shared\n\nCOMMON8642\n', modes: ['conversation'] })
  const { IndexEngine } = load('src/main/library-v4/indexing.ts'),
    engine = new IndexEngine(db, io)
  await engine.build('p', 'full')
  await engine.build('p', 'full')
  return {
    root,
    service,
    db,
    a,
    b,
    collections,
    setFailure: (v) => {
      fail = v
    }
  }
}
test('permanent deletion scrubs SQLite and all historical vector collections while preserving shared chunks', async (t) => {
  const x = await setup(t),
    session = x.db.chat.create('p'),
    turn = x.db.chat.begin('p', session.id, 'r', 'q')
  x.db.chat.finish(turn.id, 'completed', 'SECRET731', {
    sources: [{ docId: x.a.id, text: 'SECRET731' }]
  })
  const trashed = x.service.trash('p', x.a.id, x.a.version)
  const task = x.service.scheduleDocumentPurge('p', x.a.id, trashed.version, true)
  await x.service.drain()
  assert.equal(x.service.task('p', task.id).status, 'done')
  assert.throws(() => x.db.get('p', x.a.id))
  assert.equal(
    x.db.db.prepare('SELECT count(*) AS n FROM document_revisions WHERE doc_id=?').get(x.a.id).n,
    0
  )
  assert.equal(x.db.chat.get('p', session.id).turns.length, 0)
  for (const g of x.db.generations('p')) {
    const gen = x.db.generation('p', g.id)
    assert.ok(!gen.manifest.some((d) => d.id === x.a.id))
    assert.ok(!gen.chunks.some((c) => c.docId === x.a.id))
    const sharedKeys = new Set(gen.chunks.map((c) => c.vectorKey))
    for (const key of x.collections.get(gen.collection).keys()) assert.ok(sharedKeys.has(key))
  }
  assert.equal(x.db.get('p', x.b.id).text, x.b.text)
})
test('vector failure keeps SQLite recoverable for retry and blocks restoring partial purges', async (t) => {
  const x = await setup(t),
    d = x.service.trash('p', x.a.id, x.a.version)
  x.setFailure(true)
  const task = x.service.scheduleDocumentPurge('p', x.a.id, d.version, true)
  await x.service.drain()
  assert.equal(x.service.task('p', task.id).status, 'failed')
  assert.ok(x.db.get('p', x.a.id).deletedAt)
  assert.throws(() => x.service.restore('p', x.a.id, d.version), /永久/)
  x.setFailure(false)
  assert.equal(x.service.scheduleDocumentPurge('p', x.a.id, d.version, true).id, task.id)
  await x.service.drain()
  assert.equal(x.service.task('p', task.id).status, 'done')
  assert.throws(() => x.db.get('p', x.a.id))
})
test('permanent deletion requires confirmation and a trashed unchanged document', async (t) => {
  const x = await setup(t)
  assert.throws(() => x.service.scheduleDocumentPurge('p', x.a.id, x.a.version, false), /确认/)
  assert.throws(() => x.service.scheduleDocumentPurge('p', x.a.id, x.a.version, true), /回收站/)
  const d = x.service.trash('p', x.a.id, x.a.version)
  assert.throws(() => x.service.scheduleDocumentPurge('p', x.a.id, 'stale', true), /版本|修改/)
  assert.ok(x.db.get('p', x.a.id))
})
test('unshared original files and source rows are removed, while shared originals remain usable', async (t) => {
  const x = await setup(t),
    originalDir = path.join(x.root, 'originals')
  fs.mkdirSync(originalDir, { recursive: true })
  const unique = path.join(originalDir, 'unique.txt'),
    shared = path.join(originalDir, 'shared.txt')
  fs.writeFileSync(unique, 'old private source')
  fs.writeFileSync(shared, 'shared source')
  const file1 = x.db.registerSource('p', 'unique', 'unique.txt', unique, 18)
  x.db.linkSource(x.a.revisionId, file1)
  const file2 = x.db.registerSource('p', 'shared', 'shared.txt', shared, 13)
  const updated = x.db.update('p', x.a.id, x.a.version, {
    sourcePath: shared,
    text: '# Updated\nNEW TEXT\n'
  })
  x.db.linkSource(updated.revisionId, file2)
  x.db.linkSource(x.b.revisionId, file2)
  const d = x.service.trash('p', x.a.id, updated.version)
  const task = x.service.scheduleDocumentPurge('p', x.a.id, d.version, true)
  await x.service.drain()
  assert.equal(x.service.task('p', task.id).status, 'done')
  assert.equal(fs.existsSync(unique), false)
  assert.equal(fs.existsSync(shared), true)
  assert.equal(x.db.db.prepare('SELECT count(*) AS n FROM source_files WHERE id=?').get(file1).n, 0)
  assert.equal(x.db.db.prepare('SELECT count(*) AS n FROM source_files WHERE id=?').get(file2).n, 1)
})
test('successful deletion removes private vector cache but keeps shared cache entries', async (t) => {
  const x = await setup(t),
    gen = x.db.generation('p'),
    shared = new Set(gen.chunks.filter((c) => c.docId === x.b.id).map((c) => c.inputHash)),
    unique = gen.chunks.filter((c) => c.docId === x.a.id && !shared.has(c.inputHash))
  assert.ok(unique.length > 0)
  const d = x.service.trash('p', x.a.id, x.a.version)
  x.service.scheduleDocumentPurge('p', x.a.id, d.version, true)
  await x.service.drain()
  for (const c of unique) assert.equal(x.db.cachedVector(gen.fingerprint, c.inputHash), undefined)
  for (const hash of shared) assert.ok(x.db.cachedVector(gen.fingerprint, hash))
})
