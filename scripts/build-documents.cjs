const path = require('node:path')
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, '../src/main/document-worker.ts')],
  outfile: path.join(__dirname, '../out/main/document-worker.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external'
})
console.log('本地文档解析组件构建完成')

require('./build-library-tools.cjs')

require('./build-library-service.cjs')
