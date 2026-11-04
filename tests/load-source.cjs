const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Exercise the checked-in TypeScript without adding a test runtime dependency.
module.exports = function loadSource(file, mocks = {}, cache = new Map()) {
  file = path.resolve(__dirname, '..', file)
  if (cache.has(file)) return cache.get(file).exports
  const mod = { exports: {} }
  cache.set(file, mod)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const localRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id]
    if (id.startsWith('.')) {
      return module.exports(path.resolve(path.dirname(file), id + '.ts'), mocks, cache)
    }
    return require(id)
  }
  new Function('require', 'module', 'exports', '__dirname', code)(localRequire, mod, mod.exports, path.dirname(file))
  return mod.exports
}
