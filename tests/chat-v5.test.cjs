const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  load = require('./load-source.cjs')
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-chat-')),
    file = path.join(dir, 'db')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { Catalog } = load('src/main/library-v4/catalog.ts'),
    db = new Catalog(file)
  t.after(() => db.close())
  db.project('p', 'P')
  db.project('other', 'Other')
  db.activeDocuments = (p, mode) => db.list(p).filter((d) => !mode || d.modes.includes(mode))
  return { db, file }
}
async function collect(g) {
  const rows = []
  for await (const x of g) rows.push(x)
  return rows
}
test('schema5 upgrades additively; chat scopes projects, idempotency and restart recovery', async (t) => {
  const x = setup(t),
    d = x.db.create('p', { name: 'manual', text: '不能丢的人工正文731', modes: ['conversation'] }),
    s = x.db.chat.create('p')
  assert.throws(() => x.db.chat.get('other', s.id))
  const a = x.db.chat.begin('p', s.id, 'req1', '问题'),
    same = x.db.chat.begin('p', s.id, 'req1', '问题')
  assert.equal(a.id, same.id)
  assert.throws(() => x.db.chat.begin('p', s.id, 'req1', '不同问题'))
  assert.throws(() => x.db.chat.begin('p', s.id, 'req2', '另一个问题'))
  x.db.chat.recover()
  assert.equal(x.db.chat.get('p', s.id).turns[0].status, 'interrupted')
  assert.equal(x.db.get('p', d.id).text, '不能丢的人工正文731')
  assert.equal(x.db.chat.history('p', s.id).length, 0)
  x.db.setProjectState('p', x.db.projectInfo('p').version, true)
  assert.throws(() => x.db.chat.get('p', s.id))
  x.db.setProjectState('p', x.db.projectInfo('p', true).version, false)
  assert.equal(x.db.chat.get('p', s.id).turns.length, 1)
})
test('chat uses final evidence only, saves success once and replays without provider billing', async (t) => {
  const x = setup(t),
    d = x.db.create('p', { name: '资料', text: '编号731', modes: ['conversation'] }),
    evidence = [
      { id: 'c1', docId: d.id, revision: d.textHash, number: 1, name: d.name, text: d.text }
    ],
    s = x.db.chat.create('p')
  let calls = 0
  const ai = {
    status: () => ({ configured: true }),
    rewrite: async () => {
      throw Error('not needed')
    },
    async *answer(messages, context) {
      calls++
      assert.match(context, /731/)
      yield '编号731 [1]'
      yield ' [99]'
    }
  }
  const { ChatCoordinator } = load('src/main/library-v4/chat.ts'),
    chat = new ChatCoordinator(
      x.db,
      async () => ({ hits: [{ id: 'rough' }], evidence, context: '编号731', diagnostics: {} }),
      ai
    )
  const events = await collect(chat.run('p', s.id, { requestId: 'r1', question: '编号是多少' }))
  const turn = x.db.chat.get('p', s.id).turns[0]
  assert.equal(turn.status, 'completed')
  assert.equal(turn.sources.length, 1)
  assert.equal(turn.sources[0].id, 'c1')
  assert.doesNotMatch(turn.answer, /\[99\]/)
  assert.equal(events.at(-1).type, 'done')
  await collect(chat.run('p', s.id, { requestId: 'r1', question: '编号是多少' }))
  assert.equal(calls, 1)
  assert.equal(x.db.chat.history('p', s.id).length, 2)
  await chat.close()
})
test('source deletion while generating interrupts partial text and excludes it from history', async (t) => {
  const x = setup(t),
    d = x.db.create('p', { name: 'D', text: '答案731', modes: ['conversation'] }),
    s = x.db.chat.create('p'),
    ai = {
      status: () => ({ configured: true }),
      async *answer() {
        yield '部分'
        x.db.trash('p', d.id, d.version)
        yield '过期内容'
      }
    }
  const { ChatCoordinator } = load('src/main/library-v4/chat.ts'),
    chat = new ChatCoordinator(
      x.db,
      async () => ({
        evidence: [{ id: 'c', docId: d.id, revision: d.textHash, number: 1, text: d.text }],
        context: 'c',
        diagnostics: {}
      }),
      ai
    )
  const events = await collect(chat.run('p', s.id, { requestId: 'r1', question: '答案' }))
  const turn = x.db.chat.get('p', s.id).turns[0]
  assert.equal(turn.status, 'interrupted')
  assert.equal(turn.answer, '部分')
  assert.equal(x.db.chat.history('p', s.id).length, 0)
  assert.equal(events.at(-1).type, 'error')
  await chat.close()
})
test('explicit stop aborts provider and persists an interrupted turn', async (t) => {
  const x = setup(t),
    s = x.db.chat.create('p'),
    d = x.db.create('p', { name: 'd', text: '731', modes: ['conversation'] }),
    ai = {
      status: () => ({ configured: true }),
      async *answer(_m, _c, signal) {
        yield '部分'
        signal.throwIfAborted()
        await new Promise((r, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    }
  const { ChatCoordinator } = load('src/main/library-v4/chat.ts'),
    chat = new ChatCoordinator(
      x.db,
      async () => ({
        evidence: [{ id: 'c', docId: d.id, revision: d.textHash, number: 1, text: d.text }],
        context: '731',
        diagnostics: {}
      }),
      ai
    )
  let stopped = false
  for await (const e of chat.run('p', s.id, { requestId: 'r1', question: '问题' })) {
    if (e.type === 'token') {
      chat.stop('p', s.id, e.turnId)
      stopped = true
    }
  }
  assert.equal(stopped, true)
  assert.equal(x.db.chat.get('p', s.id).turns[0].status, 'interrupted')
  await chat.close()
})

test('real version5 catalog migrates to6 without changing existing documents; future versions reject', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-migrate6-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'db'),
    { Library } = load('src/main/library/repository.ts')
  const old = new Library(file)
  old.project('p', 'P')
  const d = old.create('p', {
    name: 'D',
    text: '原有人工正文731',
    modes: ['conversation'],
    tags: ['保留']
  })
  old.close()
  const { DatabaseSync } = require('node:sqlite')
  let raw = new DatabaseSync(file)
  raw.exec('PRAGMA user_version=5')
  raw.close()
  const { Catalog } = load('src/main/library-v4/catalog.ts'),
    db = new Catalog(file)
  assert.equal(db.get('p', d.id).version, d.version)
  assert.equal(db.get('p', d.id).text, d.text)
  assert.deepEqual(db.get('p', d.id).tags, ['保留'])
  db.close()
  raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6)
  raw.exec('PRAGMA user_version=7')
  raw.close()
  assert.throws(() => new Catalog(file), /版本高于/)
  raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 7)
  raw.close()
})

test('ordinary chat skips retrieval and rewriting, streams the model and preserves numeric brackets', async (t) => {
  const x = setup(t),
    s = x.db.chat.create('p')
  let calls = 0
  x.db.activeDocuments = () => {
    throw Error('ordinary chat must not read documents')
  }
  const ai = {
    status: () => ({ configured: true }),
    rewrite: async () => {
      throw Error('must not rewrite')
    },
    async *answer(messages, context, signal, useKnowledge) {
      calls++
      assert.equal(useKnowledge, false)
      assert.equal(context, '')
      assert.equal(messages.at(-1).content, '你好')
      yield '你好，数组下标 [1]'
    }
  }
  const { ChatCoordinator } = load('src/main/library-v4/chat.ts'),
    chat = new ChatCoordinator(
      x.db,
      async () => {
        throw Error('must not search')
      },
      ai
    )
  const input = { requestId: 'direct-1', question: '你好', useKnowledge: false }
  const events = await collect(chat.run('p', s.id, input))
  assert.equal(events.at(-1).type, 'done')
  const turn = events.at(-1).turn
  assert.equal(turn.useKnowledge, false)
  assert.deepEqual(turn.sources, [])
  assert.equal(turn.answer, '你好，数组下标 [1]')
  await collect(chat.run('p', s.id, input))
  assert.equal(calls, 1)
  await chat.close()
})
