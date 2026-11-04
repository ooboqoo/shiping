const test = require('node:test')
const assert = require('node:assert/strict')
const {mkdtempSync, rmSync} = require('node:fs')
const {tmpdir} = require('node:os')
const {join} = require('node:path')
const load = require('./load-source.cjs')
test('first installation requires explicit model selection', () => {
  const {createProfile} = load('src/renderer/src/lib/api-profiles.ts')
  assert.equal(createProfile({apiBaseURL: 'https://api.deepseek.com'}).model, '')
  assert.equal(createProfile({model: 'user-model'}).model, 'user-model')
  const root = mkdtempSync(join(tmpdir(), 'shiping-first-'))
  try {
    const {ModelProviders} = load('src/main/library-v4/model-providers.ts')
    const providers = new ModelProviders(root)
    assert.equal(providers.status().model, '')
    assert.equal(providers.isConfigured(), false)
  } finally { rmSync(root, {recursive:true, force:true}) }
})
