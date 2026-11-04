const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  load = require('./load-source.cjs')
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-library-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { Library } = load('src/main/library/repository.ts')
  const db = new Library(path.join(root, 'library.sqlite'))
  t.after(() => db.close())
  return { root, db, Library }
}
test('SQLite CRUD uses immutable revisions and optimistic version conflicts', (t) => {
  const { db } = setup(t)
  db.project('shiping', 'Shiping')
  const d = db.create('shiping', {
    id: 'one',
    name: '笔记',
    text: '原始事实731',
    modes: ['conversation'],
    tags: []
  })
  const next = db.update('shiping', 'one', d.version, { text: '更新事实8642' })
  assert.equal(db.get('shiping', 'one').text, '更新事实8642')
  assert.equal(db.revisions('shiping', 'one').length, 2)
  assert.throws(() => db.update('shiping', 'one', d.version, { text: '过期修改' }), /版本冲突/)
  db.trash('shiping', 'one', next.version)
  assert.equal(db.list('shiping').length, 0)
  assert.equal(db.list('shiping', true).length, 1)
  const deleted = db.get('shiping', 'one')
  db.restore('shiping', 'one', deleted.version)
  assert.equal(db.list('shiping').length, 1)
})
test('migration is idempotent, preserves metadata and rejects conflicting content', (t) => {
  const { db } = setup(t)
  db.project('p', '项目')
  const legacy = {
    id: 'old',
    name: '旧资料',
    text: '原文',
    modes: ['screenshot'],
    tags: ['课程'],
    updatedAt: 123,
    deletedAt: 456
  }
  assert.equal(db.importLegacy('p', legacy), 'imported')
  assert.equal(db.importLegacy('p', legacy), 'unchanged')
  assert.equal(db.get('p', 'old').deletedAt, 456)
  assert.equal(db.get('p', 'old').updatedAt, 123)
  assert.throws(() => db.importLegacy('p', { ...legacy, text: '意外变化' }), /冲突/)
  assert.equal(db.revisions('p', 'old').length, 1)
})
test('independent SQLite connections see committed revisions and enforce project boundaries', (t) => {
  const { root, db, Library } = setup(t)
  db.project('a', 'A')
  db.project('b', 'B')
  const d = db.create('a', { id: 'same', name: 'A', text: 'A正文', modes: [], tags: [] })
  const other = new Library(path.join(root, 'library.sqlite'))
  t.after(() => other.close())
  other.update('a', 'same', d.version, { text: '另一连接' })
  assert.equal(db.get('a', 'same').text, '另一连接')
  assert.throws(() => db.get('b', 'same'), /不存在/)
  assert.throws(() => db.update('a', 'same', d.version, { text: '旧版本' }), /版本冲突/)
})
test('consistent backup restores revisions and rejects newer unsupported schema', async (t) => {
  const { root, db, Library } = setup(t)
  db.project('p', 'P')
  db.create('p', { id: 'd', name: 'D', text: '备份事实', modes: [], tags: [] })
  const target = path.join(root, 'backup.sqlite')
  await db.backup(target)
  const restored = new Library(target)
  assert.equal(restored.get('p', 'd').text, '备份事实')
  restored.close()
  const { DatabaseSync } = require('node:sqlite'),
    bad = path.join(root, 'newer.sqlite'),
    raw = new DatabaseSync(bad)
  raw.exec('PRAGMA user_version=999')
  raw.close()
  assert.throws(() => new Library(bad), /版本/)
})
test('legacy changes to provenance are a migration conflict rather than silently ignored', (t) => {
  const { db } = setup(t)
  db.project('p', 'P')
  const d = { id: 'x', name: 'X', text: 'same', modes: [], updatedAt: 1, source: 'old.pdf' }
  db.importLegacy('p', d)
  assert.throws(() => db.importLegacy('p', { ...d, source: 'different.pdf' }), /冲突/)
})
test('project snapshot commit is atomic and rejects stale multi-connection writes',t=>{
 const {db,root,Library}=setup(t);db.project('p','P');const a=db.create('p',{id:'a',name:'A',text:'正文A',modes:[],tags:[]});const b=db.create('p',{id:'b',name:'B',text:'正文B',modes:[],tags:[]});const snapshot=[a,b]
 const second=new Library(path.join(root,'library.sqlite'));t.after(()=>second.close());second.update('p','b',b.version,{text:'外部修改'})
 assert.throws(()=>db.replaceProject('p',[{...a,text:'不得部分写入'},b],snapshot),/冲突/);assert.equal(db.get('p','a').text,'正文A')
 const current=[db.get('p','a'),db.get('p','b')];const version='client-version-token';db.replaceProject('p',[{...current[0],text:'提交',version},current[1]],current);assert.equal(db.get('p','a').version,version)
})
