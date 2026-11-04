const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
test('desktop settings dispatch only fixed provider methods to the shared backend', async () => {
  const { createModelSettingsHandler } = load('src/main/library-v4/model-settings.ts'),
    calls = []
  const handle = createModelSettingsHandler(() => ({
    call: async (method, args) => {
      calls.push({ method, args })
      return { ok: true }
    }
  }))
  await handle('status')
  await handle('save', 'embedding', { provider: 'ollama' })
  await handle('models', 'rerank', { provider: 'xinference' })
  await handle('test', 'embedding', { provider: 'siliconflow' })
  await handle('rerank-enabled', undefined, true)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['providerStatus', 'configureProvider', 'providerModels', 'testProvider', 'configureRetrieval']
  )
  assert.deepEqual(calls[4].args, [true])
  await assert.rejects(handle('deleteEverything'), /操作无效/)
  await assert.rejects(handle('save', 'chat', {}), /类型无效/)
  await assert.rejects(handle('rerank-enabled', undefined, 'yes'), /开关无效/)
})
test('desktop reports unavailable shared service rather than keeping an unrelated second config', async () => {
  const { createModelSettingsHandler } = load('src/main/library-v4/model-settings.ts')
  await assert.rejects(createModelSettingsHandler(() => undefined)('status'), /本机知识库服务/)
})
