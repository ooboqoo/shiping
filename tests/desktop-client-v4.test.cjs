const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),load=require('./load-source.cjs')
test('desktop uses authenticated backend and never creates fallback records when unavailable',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shiping-client-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const {DesktopLibrary}=load('src/main/library-v4/desktop-client.ts'),file=path.join(dir,'service.json'),client=new DesktopLibrary(file);await assert.rejects(client.call('create',['shiping',{name:'A',text:'B'}]),/本地知识库服务/);assert.deepEqual(await fs.readdir(dir),[]);await fs.writeFile(file,JSON.stringify({url:'https://example.com',token:'a'.repeat(64)}),{mode:0o600});await assert.rejects(client.call('list',['shiping']),/本地知识库服务/);await fs.chmod(file,0o644);await assert.rejects(client.call('list',['shiping']),/本地知识库服务/)})
test('desktop lifecycle record identifies this process and cleanup removes only its own record',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shiping-desktop-record-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const {DesktopLibrary}=load('src/main/library-v4/desktop-client.ts'),client=new DesktopLibrary(path.join(dir,'service.json'));const cleanup=await client.register();const record=JSON.parse(await fs.readFile(path.join(dir,'desktop.json'),'utf8'));assert.equal(record.pid,process.pid);assert.ok(record.start);await cleanup();await assert.rejects(fs.access(path.join(dir,'desktop.json')))})

test('discovery permission checks use POSIX modes only on POSIX platforms',()=>{const {privateFileMode}=load('src/main/library-v4/desktop-client.ts');assert.equal(privateFileMode(0o644,'darwin'),false);assert.equal(privateFileMode(0o600,'darwin'),true);assert.equal(privateFileMode(0o666,'win32'),true)})

test('desktop upload forwards the selected project instead of the default library', async () => {
  let target
  const {DesktopLibrary} = load('src/main/library-v4/desktop-client.ts', {
    './desktop-upload': {uploadLocalFile: async (...args) => {target=args[2]; return {jobId:'job'}}}
  })
  const client = new DesktopLibrary('unused')
  client.connection = async () => ({url:'http://127.0.0.1:1234'})
  await client.upload('file.pdf', 'submission', () => {}, undefined, 'other-library')
  assert.equal(target, 'other-library')
})
