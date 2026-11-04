const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  load = require('./load-source.cjs')
test('library paths use portable app data on fresh installs and reuse the existing library root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-paths-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const user = path.join(root, 'data', 'desktop'),
    { libraryPaths } = load('src/main/library-v4/paths.ts')
  assert.equal(libraryPaths(user).root, path.join(user, 'library-runtime'))
  fs.mkdirSync(path.join(root, 'data', 'library'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'library', 'v4-active.json'), '{"version":1}')
  assert.equal(libraryPaths(user).root, root)
})
test('fresh bootstrap creates a usable default library and never overwrites an existing database', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-init-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { initializeLibrary } = load('src/main/library-v4/initialize.ts')
  await initializeLibrary(root)
  const { Catalog } = load('src/main/library-v4/catalog.ts')
  let c = new Catalog(path.join(root, 'data/library/shiping.sqlite'))
  c.create('shiping', { name: '保留资料', text: '原文123', modes: ['conversation'] })
  c.close()
  await initializeLibrary(root)
  c = new Catalog(path.join(root, 'data/library/shiping.sqlite'))
  assert.equal(c.list('shiping')[0].text, '原文123')
  c.close()
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'data/library/v4-active.json'))).version,
    1
  )
})
test('managed service starts itself, shares one owner and stops only its own child', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const entry = path.join(dir, 'fixture.cjs')
  fs.writeFileSync(
    entry,
    `const fs=require('node:fs'),http=require('node:http'),path=require('node:path');const d=path.join(process.env.RAG_ADMIN_ROOT,'data/library');fs.mkdirSync(d,{recursive:true});const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,storage:'sqlite-vectors'}))});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(d,'service.json'),JSON.stringify({url:'http://127.0.0.1:'+server.address().port,token:'a'.repeat(64),pid:process.pid}),{mode:0o600}));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`
  )
  const { ManagedLibrary } = load('src/main/library-v4/managed.ts'),
    one = new ManagedLibrary({ root: dir, entry, publicDir: dir }),
    two = new ManagedLibrary({ root: dir, entry, publicDir: dir })
  t.after(() => one.stop())
  t.after(() => two.stop())
  const [a, b] = await Promise.all([one.ready(), one.ready()])
  assert.equal(a, b)
  assert.equal(await two.ready(), a)
  await two.stop()
  assert.equal((await fetch(a)).status, 200)
  await one.stop()
  await assert.rejects(fetch(a))
  await assert.rejects(one.ready(), /关闭/)
})

test('legacy activation with missing database fails without creating an empty replacement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-legacy-db-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'data/library')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'active.json'), '{"version":1,"database":"shiping.sqlite"}')
  const { initializeLibrary } = load('src/main/library-v4/initialize.ts')
  await assert.rejects(initializeLibrary(root), /数据库缺失/)
  assert.equal(fs.existsSync(path.join(dir, 'shiping.sqlite')), false)
})
test('legacy plain documents migrate once and queue indexing for first model configuration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-auto-index-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const legacy = path.join(root, 'old')
  fs.mkdirSync(legacy)
  fs.writeFileSync(
    path.join(legacy, 'index.json'),
    JSON.stringify([{ id: 'legacy-doc', name: '旧资料', modes: ['conversation'] }])
  )
  fs.writeFileSync(path.join(legacy, 'legacy-doc.txt'), '旧知识8642')
  const { initializeLibrary } = load('src/main/library-v4/initialize.ts')
  await initializeLibrary(root, legacy)
  await initializeLibrary(root, legacy)
  const { Catalog } = load('src/main/library-v4/catalog.ts'),
    c = new Catalog(path.join(root, 'data/library/shiping.sqlite'))
  assert.equal(c.list('shiping').length, 1)
  assert.ok(c.tasks('shiping').some((j) => j.kind === 'index' && j.status === 'queued'))
  c.close()
})
