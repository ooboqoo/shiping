const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const path = require('node:path')
function mount(component, api, props = {}, file = 'LibraryModelSettings.tsx') {
  const slots = [],
    effects = []
  let cursor = 0,
    mounted = false
  const jsx = (type, props) => ({ type, props })
  const react = {
    useState(initial) {
      const i = cursor++
      if (!mounted) slots[i] = typeof initial === 'function' ? initial() : initial
      return [
        slots[i],
        (value) => {
          slots[i] = typeof value === 'function' ? value(slots[i]) : value
        }
      ]
    },
    useRef(value) {
      const i = cursor++
      if (!mounted) slots[i] = { current: value }
      return slots[i]
    },
    useCallback: (fn) => fn,
    useEffect(fn) {
      if (!mounted) effects.push(fn)
    }
  }
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/settings', file), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText
  const ctx = {
    module,
    exports: module.exports,
    window: { api, addEventListener() {}, removeEventListener() {} },
    setInterval() {},
    clearInterval() {},
    require(id) {
      if (id === '@/lib/store/settings')
        return {
          useSettingsStore: (selector) =>
            selector({ ragConfig: { mode: 'full' }, updateSetting() {} })
        }
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (id === 'react-router') return { Link: 'Link' }
      return new Proxy({}, { get: (_target, key) => key })
    }
  }
  vm.runInNewContext(code, ctx)
  const render = () => {
    cursor = 0
    const tree = module.exports[component](props)
    mounted = true
    return tree
  }
  render()
  effects.forEach((fn) => fn())
  return {
    render,
    flush: () => new Promise((resolve) => setImmediate(resolve))
  }
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
const status = {
  embedding: { provider: 'ollama' },
  rerank: { provider: 'local', enabled: true, model: 'old' }
}
test('AI rerank card shows explicit legacy placeholder and cannot save or test the removed provider', async () => {
  const calls = []
  const x = mount(
    'LibraryModelSettingsCard',
    {
      getLibraryModelSettings: async () => status,
      saveLibraryModel: async () => calls.push('save'),
      testLibraryModel: async () => calls.push('test')
    },
    { kind: 'rerank' }
  )
  await x.flush()
  const tree = nodes(x.render())
  assert.equal(
    tree.some((n) => n.type === 'Switch'),
    false
  )
  assert.ok(tree.some((n) => n.props['aria-label'] === 'rerank 提供商'))
  for (const button of tree.filter(
    (n) => n.type === 'Button' && ['保存配置', '测试连接'].includes(n.props.children)
  )) {
    assert.equal(button.props.disabled, true)
    await button.props.onClick()
  }
  assert.equal(calls.length, 0)
})
test('library rerank control only persists enabled state and links to AI model configuration', async () => {
  const calls = []
  const x = mount('LibraryRerankSwitch', {
    getLibraryModelSettings: async () => ({
      ...status,
      rerank: { provider: 'siliconflow', model: 'reranker', enabled: false }
    }),
    setLibraryRerank: async (enabled) => {
      calls.push(enabled)
      return { reranker: enabled }
    }
  })
  await x.flush()
  let tree = nodes(x.render())
  assert.equal(
    tree.some((n) => n.type === 'Select' || n.type === 'Input'),
    false
  )
  assert.equal(tree.find((n) => n.type === 'Link').props.to, '/settings?tab=ai')
  await tree.find((n) => n.type === 'Switch').props.onCheckedChange(true)
  await x.flush()
  tree = nodes(x.render())
  assert.equal(tree.find((n) => n.type === 'Switch').props.checked, true)
  assert.deepEqual(calls, [true])
})
test('library control cannot re-enable the retired built-in provider', async () => {
  const calls = []
  const x = mount('LibraryRerankSwitch', {
    getLibraryModelSettings: async () => status,
    setLibraryRerank: async (v) => calls.push(v)
  })
  await x.flush()
  const control = nodes(x.render()).find((n) => n.type === 'Switch')
  assert.equal(control.props.checked, false)
  assert.equal(control.props.disabled, true)
  await control.props.onCheckedChange(true)
  assert.deepEqual(calls, [])
})

test('first-use embedding configuration explains why uploaded material is waiting', async () => {
  const x = mount(
    'LibraryModelSettingsCard',
    {
      getLibraryModelSettings: async () => ({
        ...status,
        embedding: { provider: 'siliconflow', configured: false }
      })
    },
    { kind: 'embedding' }
  )
  await x.flush()
  const messages = nodes(x.render())
    .filter((n) => n.props.role === 'status')
    .map((n) => n.props.children)
    .join('')
  assert.match(messages, /首次使用请在此填写 API Key/)
  assert.match(messages, /上传的资料会等待模型配置/)
})

test('retrieval settings shows the actual library check message and has no obsolete index purge', async () => {
  const x = mount(
    'RagSettings',
    {
      ragStatus: async () => ({ state: 'ready' }),
      ragCheck: async () => '等待 API Key，资料已保留'
    },
    {},
    'RagSettings.tsx'
  )
  await x.flush()
  let tree = nodes(x.render())
  assert.equal(
    tree.some((n) => n.props.children === '清除Shiping索引'),
    false
  )
  const check = tree.find((n) => n.type === 'Button' && n.props.children === '检查知识库')
  assert.ok(check)
  await check.props.onClick()
  await x.flush()
  tree = nodes(x.render())
  assert.equal(
    tree.find((n) => n.props.role === 'status').props.children,
    '等待 API Key，资料已保留'
  )
})
