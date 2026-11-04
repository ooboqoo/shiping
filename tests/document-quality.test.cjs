const test=require('node:test'),assert=require('node:assert/strict'),load=require('./load-source.cjs')
test('page classification detects scan with a small watermark and mixed/complex/blank pages',()=>{
 const {classifyPage}=load('src/main/document-processing/quality.ts')
 assert.equal(classifyPage({text:'第1页',imageCoverage:.9,images:1}).type,'scan')
 assert.equal(classifyPage({text:'足够完整的原生文字内容'.repeat(20),imageCoverage:.2,images:1}).type,'mixed')
 assert.equal(classifyPage({text:'正文'.repeat(80),imageCoverage:0,images:0,columns:true}).type,'complex')
 assert.equal(classifyPage({text:'',imageCoverage:0,images:0}).type,'blank')
 assert.equal(classifyPage({text:'�'.repeat(80),imageCoverage:0,images:0}).type,'abnormal')
})
test('repeated margin removal is a reversible proposal and keeps repeated body text and page records',()=>{
 const {cleanPages}=load('src/main/document-processing/quality.ts')
 const pages=[1,2,3].map(n=>({number:n,type:'text',method:'native',status:'complete',elements:[{id:'h'+n,text:'课程页眉',bbox:[.1,.01,.8,.04],type:'paragraph'},{id:'b'+n,text:'重复知识点不得删',bbox:[.1,.3,.8,.4],type:'paragraph'}],issues:[]}))
 const result=cleanPages(pages);assert.equal(result.pages.length,3);assert.equal(result.changes.length,3);assert.doesNotMatch(result.cleaned,/课程页眉/);assert.match(result.raw,/课程页眉/);assert.equal(result.cleaned.match(/重复知识点不得删/g).length,3)
})
test('source mapping and protected code/URLs/numbers survive conservative cleaning',()=>{
 const {cleanPages}=load('src/main/document-processing/quality.ts');const text='```js\n  const n = 731\n```\nhttps://example.com/a_(b)'
 const r=cleanPages([{number:1,type:'text',method:'native',status:'complete',elements:[{id:'x',text,type:'code',bbox:[0,.2,1,.9]}],issues:[]}]);assert.ok(r.cleaned.includes(text));assert.deepEqual(r.sources.map(s=>s.elementId),['x'])
})
test('aligned continuation lines merge as a reversible change, URL/code/list remain separate',()=>{
 const {cleanPages}=load('src/main/document-processing/quality.ts'),elements=[{id:'a',type:'paragraph',text:'这是一段尚未结束的',bbox:[.1,.2,.8,.23]},{id:'b',type:'paragraph',text:'中文说明。',bbox:[.1,.24,.8,.27]},{id:'c',type:'paragraph',text:'https://example.com/731',bbox:[.1,.28,.8,.31]},{id:'d',type:'code',text:'  const x = 1',bbox:[.1,.32,.8,.35]}]
 const r=cleanPages([{number:1,type:'text',method:'native',status:'complete',elements,issues:[]}]);assert.match(r.cleaned,/尚未结束的中文说明/);assert.ok(r.changes.some(c=>c.rule==='join-line'));assert.match(r.cleaned,/https:\/\/example.com\/731\n  const x = 1/);assert.match(r.raw,/尚未结束的\n中文说明/)
})
test('two-column ordering completes the left column before the right and keeps spanning blocks',()=>{
 const {orderElements}=load('src/main/document-processing/layout.ts');const e=(id,x,y,end)=>({id,text:id,type:'paragraph',bbox:[x,y,end,y+.02]});const elements=[e('标题',.1,.02,.9),e('右一',.6,.2,.9),e('左二',.1,.3,.4),e('左一',.1,.2,.4),e('右二',.6,.3,.9),e('跨栏说明',.1,.5,.9),e('右三',.6,.6,.9),e('左三',.1,.6,.4)];assert.deepEqual(orderElements(elements,true).map(e=>e.id),['标题','左一','左二','右一','右二','跨栏说明','左三','右三']);assert.equal(new Set(orderElements(elements,true).map(e=>e.id)).size,elements.length)
})
