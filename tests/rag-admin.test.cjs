const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const load = require('./load-source.cjs')
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiping-admin-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const handlers = new Map(),
    sent = []
  const k = load('src/main/knowledge.ts', {
    './library-v4/desktop-runtime': { desktopLibrary: undefined },
    electron: {
      app: { getPath: () => root },
      ipcMain: { handle: (n, f) => handlers.set(n, f) },
      dialog: {}
    }
  })
  return { ...k, root, handlers, sent }
}
test('web knowledge mutations share desktop state, enforce versions and hide trash from prompts', async (t) => {
  const { knowledgeAdmin: admin, handlers, getKnowledgePrompt, getRagDocuments } = await setup(t)
  const doc = await admin.create({ name: '网页新增', text: '全新的知识内容' })
  assert.equal(handlers.get('knowledge:list')().length, 1)
  assert.match(getKnowledgePrompt('conversation'), /全新的知识内容/)
  const edited = await admin.update(doc.id, { version: doc.version, text: '网页修改后的知识' })
  await assert.rejects(
    admin.update(doc.id, { version: doc.version, text: '旧版本覆盖' }),
    (e) => e.status === 409
  )
  assert.equal(getRagDocuments()[0].text, '网页修改后的知识')
  const deleted = await admin.trash(doc.id, edited.version)
  assert.equal(handlers.get('knowledge:list')().length, 0)
  assert.equal(getKnowledgePrompt('conversation'), '')
  assert.deepEqual(getRagDocuments(), [])
  const restored = await admin.restore(doc.id, deleted.version)
  assert.equal(restored.text, '网页修改后的知识')
  assert.equal(getRagDocuments().length, 1)
})
test('web upload retains exact original bytes and backup restore appends documents', async (t) => {
  const { knowledgeAdmin: admin } = await setup(t)
  const doc = await admin.importFile({
    name: '知识.md',
    base64: Buffer.from('# 原文件\r\n\n你好').toString('base64')
  })
  const original = await admin.original(doc.id)
  assert.equal(Buffer.from(original.base64, 'base64').toString(), '# 原文件\r\n\n你好')
  const backup = await admin.backup()
  const result = await admin.importBackup(backup)
  assert.equal(result.added, 1)
  const docs = await admin.list()
  assert.equal(docs.length, 2)
  assert.notEqual(docs[0].id, docs[1].id)
})
test('web import rejects traversal names and invalid backup without partial imports', async (t) => {
  const { knowledgeAdmin: admin } = await setup(t)
  await assert.rejects(
    admin.importFile({ name: '../秘密.txt', base64: Buffer.from('测试').toString('base64') }),
    (e) => e.status === 400
  )
  await assert.rejects(
    admin.importBackup({
      format: 'local-rag-backup',
      version: 1,
      documents: [
        { name: '正常', text: '内容' },
        { name: '不正常', text: 12 }
      ]
    }),
    (e) => e.status === 400
  )
  assert.equal((await admin.list()).length, 0)
})
test('web buffer parsing accepts longer documents while keeping legacy importer limit', async () => {
  const { extractBufferText } = load('src/main/knowledge-parse.ts')
  const big = Buffer.from('知识'.repeat(110000))
  await assert.rejects(extractBufferText(big, 'txt'), /文字太多/)
  assert.equal((await extractBufferText(big, 'txt', 2_000_000)).length, 220000)
})

test('stale desktop editors, reimports and delete confirmations cannot overwrite newer web state', async (t) => {
  const { knowledgeAdmin: admin, handlers } = await setup(t)
  const original = await admin.importFile({
    name: 'source.txt',
    base64: Buffer.from('原始文件正文').toString('base64')
  })
  const snapshot = await handlers.get('knowledge:get-document')({}, original.id)
  assert.equal(snapshot.text, '原始文件正文')
  const current = await admin.update(original.id, { version: original.version, text: '网页新正文' })
  await assert.rejects(
    handlers.get('knowledge:update')({}, original.id, {
      version: snapshot.doc.version,
      text: '桌面旧正文'
    }),
    /其他位置|刷新/
  )
  const reimport = await handlers.get('knowledge:reimport')({}, original.id, snapshot.doc.version)
  assert.ok(reimport.error)
  assert.equal((await admin.get(original.id)).text, '网页新正文')
  await admin.trash(original.id, current.version)
  await assert.rejects(
    handlers.get('knowledge:remove')({}, original.id, current.version),
    /其他位置|刷新/
  )
  assert.equal((await admin.list({ trash: true })).length, 1)
})

test('desktop deletion is recoverable and a versioned editor snapshot matches its text', async (t) => {
  const { knowledgeAdmin: admin, handlers } = await setup(t)
  const doc = await handlers.get('knowledge:create')({}, '桌面资料', '桌面正文')
  const snapshot = await handlers.get('knowledge:get-document')({}, doc.id)
  assert.equal(snapshot.doc.version, (await admin.get(doc.id)).version)
  await handlers.get('knowledge:remove')({}, doc.id, snapshot.doc.version)
  const trash = await admin.list({ trash: true })
  assert.equal(trash.length, 1)
  assert.equal((await admin.restore(doc.id, trash[0].version)).text, '桌面正文')
})

test('notification refresh and import completion merge duplicate ids only once', () => {
  const { mergeKnowledgeDocs } = load('src/shared/knowledge.ts')
  const one = { id: 'one', name: '原资料', chars: 10, modes: ['conversation'] },
    two = { id: 'two', name: '新资料', chars: 20, modes: ['conversation'] }
  const rows = mergeKnowledgeDocs([one, two], [two])
  assert.equal(rows.length, 2)
  assert.equal(
    rows.reduce((n, d) => n + d.chars, 0),
    30
  )
})

test('existing desktop update IPC rejects a known stale web version', async (t) => {
  const { knowledgeAdmin: admin, handlers } = await setup(t),
    old = await admin.create({ name: '并发', text: '旧正文' })
  await admin.update(old.id, { version: old.version, text: '网页新正文' })
  await assert.rejects(
    handlers.get('knowledge:update')({}, old.id, { version: old.version, text: '旧桌面覆盖' }),
    /其他位置|刷新/
  )
  assert.equal((await admin.get(old.id)).text, '网页新正文')
})
test('existing desktop remove IPC cannot permanently purge a web trash entry', async (t) => {
  const { knowledgeAdmin: admin, handlers } = await setup(t),
    old = await admin.create({ name: '回收', text: '必须保留' })
  await admin.trash(old.id, old.version)
  await assert.rejects(handlers.get('knowledge:remove')({}, old.id, old.version), /其他位置|刷新/)
  assert.equal((await admin.list({ trash: true })).length, 1)
})
