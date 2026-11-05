const { test } = require('node:test')
const assert = require('node:assert/strict')
const createLoader = require('./voice-load-source.cjs')
function store(state) {
  const values = new Map()
  if (state) values.set('interview-coder-settings', JSON.stringify({ state, version: 8 }))
  global.localStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k)
  }
  const s = createLoader()('src/renderer/src/lib/store/settings.ts').useSettingsStore
  return { s, values }
}
test('existing settings adopt summary/dual defaults without losing provider credentials', () => {
  const { s } = store({ apiKey: 'test-secret', model: 'existing-model' })
  const v = s.getState()
  assert.equal(v.conversationContextEnabled, true)
  assert.equal(v.conversationContextRounds, 3)
  assert.equal(v.conversationAudioMode, 'dual')
  assert.equal(v.apiKey, 'test-secret')
  assert.equal(v.model, 'existing-model')
})
test('context off and custom rounds survive reload; invalid persisted options are normalized', () => {
  let h = store({
    conversationContextEnabled: false,
    conversationContextRounds: 7,
    conversationAudioMode: 'system'
  })
  assert.equal(h.s.getState().conversationContextEnabled, false)
  h.s.getState().updateSetting('conversationContextRounds', 5)
  h = store(JSON.parse(h.values.get('interview-coder-settings')).state)
  assert.equal(h.s.getState().conversationContextEnabled, false)
  assert.equal(h.s.getState().conversationContextRounds, 5)
  h = store({
    conversationContextRounds: 99999,
    conversationContextTokenBudget: -10,
    conversationAudioMode: 'broken'
  })
  assert.equal(h.s.getState().conversationContextRounds, 20)
  assert.equal(h.s.getState().conversationContextTokenBudget, 100)
  assert.equal(h.s.getState().conversationAudioMode, 'dual')
})
