const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path')
test('a desktop task link opens its default knowledge library and exact report',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../library-web/public/app-v4.js'),'utf8')
 const boot=source.slice(source.indexOf('async function boot()'),source.indexOf('boot().catch'))
 const job='12345678-1234-1234-1234-123456789abc',opened=[]
 const ctx={URLSearchParams,window:{location:{search:'?project=shiping&task='+job}},state:{project:'other',projects:[]},sessionClient:{refresh:async()=>({csrf:'token'})},projects:async()=>{},render:async()=>{},jobDetail:async(...args)=>opened.push(args)}
 vm.createContext(ctx);vm.runInContext(boot,ctx);await vm.runInContext('boot()',ctx)
 assert.equal(ctx.state.project,'shiping');assert.equal(ctx.state.view,'documents');assert.equal(opened[0]?.[0],job);assert.equal(opened[0]?.[1],'/projects/shiping')
})
