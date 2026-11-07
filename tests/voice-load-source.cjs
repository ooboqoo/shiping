const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

module.exports = function createLoader(mocks = {}) {
  const cache = new Map()
  return function load(file) {
    const full = path.resolve(__dirname, '..', file)
    if (cache.has(full)) return cache.get(full).exports
    const mod = { exports: {} }
    cache.set(full, mod)
    const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
      fileName: full,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText
    const req = (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) {
        if (name.endsWith('?raw'))
          return {
            __esModule: true,
            default: fs.readFileSync(path.resolve(path.dirname(full), name.slice(0, -4)), 'utf8')
          }
        let next = path.resolve(path.dirname(full), name)
        if (!path.extname(next)) next += '.ts'
        return load(next)
      }
      return require(name)
    }
    new Function('require', 'module', 'exports', js)(req, mod, mod.exports)
    return mod.exports
  }
}
