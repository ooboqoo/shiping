const path = require('node:path'),
  fs = require('node:fs')
const base = path.resolve(__dirname, '..')
const build = require('esbuild').buildSync({
  absWorkingDir: base,
  metafile: true,
  entryPoints: [path.join(base, 'src/main/library-v4/service-entry.ts')],
  outfile: path.join(base, 'out/main/library-service.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['unpdf', 'mammoth', 'tesseract.js', '@napi-rs/canvas', 'fast-xml-parser', 'yauzl']
})
for (const input of Object.keys(build.metafile.inputs)) {
  if (path.resolve(base, input).includes(path.sep + 'local-rag' + path.sep))
    throw Error('内置知识库构建不得依赖项目外的 local-rag 目录')
}
const assets = path.join(base, 'resources/library-web')
fs.mkdirSync(assets, { recursive: true })
for (const file of [
  'index.html',
  'app-v4.js',
  'model-providers.js',
  'ui-helpers.js',
  'chat-ui.js',
  'uploads-ui.js',
  'document-purge-ui.js',
  'style.css'
]) {
  fs.copyFileSync(path.join(base, 'library-web/public', file), path.join(assets, file))
}
console.log('内置知识库服务与网页组件构建完成')
