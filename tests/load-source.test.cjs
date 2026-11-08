const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const load = require('./load-source.cjs')

test('real raw prompt imports allow settings hydration and saved values to survive restart', (t) => {
  const previous = global.localStorage
  const saved = new Map([
    [
      'interview-coder-settings',
      JSON.stringify({
        version: 8,
        state: {
          apiKey: 'fixture-key',
          model: 'fixture-model',
          stealthEnabled: false
        }
      })
    ]
  ])
  global.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key)
  }
  t.after(() => {
    global.localStorage = previous
  })
  const { useSettingsStore: store } = load('src/renderer/src/lib/store/settings.ts')
  assert.equal(store.persist.hasHydrated(), true)
  assert.equal(store.getState().apiKey, 'fixture-key')
  assert.equal(store.getState().model, 'fixture-model')
  assert.equal(store.getState().stealthEnabled, false)
  const prompt = fs.readFileSync(
    path.join(__dirname, '../src/renderer/src/lib/store/prompts/general-qa.md'),
    'utf8'
  )
  assert.equal(store.getState().scenes.find((scene) => scene.id === 'general-qa').prompt, prompt)
  store.getState().setModel('next-model')
  const { useSettingsStore: restarted } = load.createLoader()(
    'src/renderer/src/lib/store/settings.ts'
  )
  assert.equal(restarted.persist.hasHydrated(), true)
  assert.equal(restarted.getState().model, 'next-model')
  assert.equal(restarted.getState().apiKey, 'fixture-key')
  assert.equal(restarted.getState().stealthEnabled, false)
})
