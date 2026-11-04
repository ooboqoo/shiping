const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  load = require('./load-source.cjs')
test('legacy migration leaves source unchanged and verifies candidate, backup and restore', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'data/shiping-trial/knowledge')
  fs.mkdirSync(dir, { recursive: true })
  const docs = [{ id: 'a', name: '原笔记', modes: ['conversation'], updatedAt: 100 }]
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(docs))
  fs.writeFileSync(path.join(dir, 'a.txt'), '课程事实731')
  const source = fs.readFileSync(path.join(dir, 'index.json'))
  const { migrateLegacy, snapshotLegacy } = load('src/main/library/migrate.ts')
  const { Library } = load('src/main/library/repository.ts')
  const backup = path.join(root, 'backup')
  snapshotLegacy(root, backup)
  const candidate = path.join(root, 'candidate.sqlite')
  const report = migrateLegacy(root, candidate)
  assert.equal(report.activated, false)
  assert.equal(report.documents, 1)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'index.json')), source)
  const restored = path.join(root, 'restored.sqlite')
  migrateLegacy(backup, restored)
  const db = new Library(restored)
  assert.equal(db.get('shiping', 'a').text, '课程事实731')
  db.close()
  assert.throws(() => migrateLegacy(root, candidate), /已存在/)
})
test('backup rejects source changes between copying index and body', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-snapshot-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'data/shiping-trial/knowledge')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([{ id: 'a' }]))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'old')
  const api = load('src/main/library/migrate.ts', {
    'node:fs': {
      ...fs,
      copyFileSync: (a, b) => {
        fs.copyFileSync(a, b)
        if (a.endsWith('index.json'))
          fs.writeFileSync(path.join(dir, 'a.txt'), 'changed after copying')
      }
    }
  })
  assert.throws(() => api.snapshotLegacy(root, path.join(root, 'backup')), /变化/)
})
