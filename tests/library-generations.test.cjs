const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),load=require('./load-source.cjs')
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shiping-generations-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const {Library}=load('src/main/library/repository.ts'),db=new Library(path.join(dir,'library.sqlite'));t.after(()=>db.close());db.project('shiping','Shiping');const doc=db.create('shiping',{id:'d',name:'D',text:'原正文731',modes:['conversation'],tags:[]});return {db,doc}}
function io(change){let count=0,ids=[];return {fingerprint:async()=> 'model:1024',embed:async xs=>{change?.();return xs.map(()=>[1,0])},request:async(url,body)=>{if(url.endsWith('/count'))return count;if(url.endsWith('/get'))return {ids:ids.slice(body.offset||0,(body.offset||0)+body.limit)};if(url.endsWith('/upsert')){count+=body.ids.length;ids.push(...body.ids);return {}}return {id:'isolated'}}}}
test('reviewed text and index pointer activate together after candidate verification',async t=>{
 const {db,doc}=setup(t),{buildGeneration}=load('src/main/library/generations.ts');const job=db.createJob('shiping',doc.id,{expectedVersion:doc.version,sourceName:'source.txt',inputPath:'/local/source.txt'});db.setJob('shiping',job.id,'ready',{complete:true,cleaned:'清洗事实8642',sources:[],pages:[]});await buildGeneration(db,'shiping',job.id,io());assert.equal(db.get('shiping',doc.id).text,'清洗事实8642');assert.ok(db.generation('shiping').collection.startsWith('shiping_knowledge_bgem3_v3_'));assert.equal(db.job('shiping',job.id).status,'applied')
})
test('concurrent edit during vector build rejects activation and keeps old pointer',async t=>{
 const {db,doc}=setup(t),{buildGeneration}=load('src/main/library/generations.ts');await buildGeneration(db,'shiping',undefined,io());const before=db.generation('shiping').id;let edited=false;await assert.rejects(buildGeneration(db,'shiping',undefined,io(()=>{if(!edited){edited=true;db.update('shiping',doc.id,doc.version,{text:'构建期间新正文'})}})),/发生变化/);assert.equal(db.generation('shiping').id,before);assert.equal(db.get('shiping',doc.id).text,'构建期间新正文')
})
test('vector failure cannot replace confirmed source text',async t=>{
 const {db,doc}=setup(t),{buildGeneration}=load('src/main/library/generations.ts');const job=db.createJob('shiping',doc.id,{expectedVersion:doc.version});db.setJob('shiping',job.id,'ready',{complete:true,cleaned:'不得启用',sources:[],pages:[]});const broken=io();broken.embed=async()=>{throw Error('离线')};await assert.rejects(buildGeneration(db,'shiping',job.id,broken),/离线/);assert.equal(db.get('shiping',doc.id).text,'原正文731');assert.equal(db.generation('shiping'),undefined)
})
test('rollback restores source and pointer but refuses to resurrect deleted material',async t=>{
 const {db,doc}=setup(t),{buildGeneration}=load('src/main/library/generations.ts');await buildGeneration(db,'shiping',undefined,io());const first=db.generation('shiping').id;const job=db.createJob('shiping',doc.id,{expectedVersion:doc.version,sourceName:'source.txt',inputPath:'/local/source.txt'});db.setJob('shiping',job.id,'ready',{complete:true,cleaned:'新版本8642',sources:[],pages:[]});await buildGeneration(db,'shiping',job.id,io());assert.equal(db.get('shiping','d').text,'新版本8642');db.rollbackGeneration('shiping',first);assert.equal(db.get('shiping','d').text,'原正文731');const current=db.get('shiping','d');db.trash('shiping','d',current.version);assert.throws(()=>db.rollbackGeneration('shiping',first),/删除|状态/)
})

test('same count with incorrect remote chunk identifiers cannot activate',async t=>{
 const {db}=setup(t),{buildGeneration}=load('src/main/library/generations.ts');const base=io(),broken={...base,request:async(url,body)=>url.endsWith('/get')?{ids:['wrong-chunk']}:base.request(url,body)};await assert.rejects(buildGeneration(db,'shiping',undefined,broken),/编号/);assert.equal(db.generation('shiping'),undefined)
})

test('manual body edits never reuse stale PDF page mappings',async t=>{
 const {db,doc}=setup(t),{buildGeneration}=load('src/main/library/generations.ts');const job=db.createJob('shiping',doc.id,{expectedVersion:doc.version,ext:'pdf'});db.setJob('shiping',job.id,'ready',{complete:true,cleaned:'原报告正文',sources:[{start:0,end:200,page:8}],pages:[]});const d=db.update('shiping',doc.id,doc.version,{text:'人工新正文',processingJob:job.id});await buildGeneration(db,'shiping',undefined,io());assert.ok(db.generation('shiping').chunks.length);assert.deepEqual(db.generation('shiping').chunks[0].pages,[])
})
