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
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  const localRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id]
    if (id.startsWith('.')) {
      const target = path.resolve(path.dirname(file), id.replace(/\?raw$/, ''))
      if (id.endsWith('?raw')) return { __esModule: true, default: fs.readFileSync(target, 'utf8') }
      const resolved = [target, target + '.ts', target + '.tsx'].find(
        (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      )
      return module.exports(resolved ?? target, mocks, cache)
    }
    return require(id)
  }
  new Function('require', 'module', 'exports', '__filename', '__dirname', code)(
    localRequire,
    mod,
    mod.exports,
    file,
    path.dirname(file)
  )
  return mod.exports
}

module.exports.createLoader = (mocks = {}) => {
  const cache = new Map()
  return (file) => module.exports(file, mocks, cache)
}
