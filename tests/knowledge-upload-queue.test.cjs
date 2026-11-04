const test = require('node:test'), assert = require('node:assert/strict'), load = require('./load-source.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
test('native queue retains submission across failed retries and never retries an accepted parse task', async t => {
  const previous = global.window; t.after(() => { global.window = previous })
  let progress, complete, reject, calls = [], notices = []
  global.window = { api: {
    onKnowledgeUploadProgress: cb => { progress = cb },
    uploadKnowledgeFile: (path, submission, project) => { calls.push({ path, submission, project }); return new Promise((a,b) => {complete=a;reject=b}) },
    cancelKnowledgeUpload: async () => {}
  }}
  const api = load('src/renderer/src/lib/knowledge-uploads.ts', {
    react: { useEffect: () => {}, useSyncExternalStore: (_, snapshot) => snapshot() },
    sonner: { toast: { error: text => notices.push(text) } }
  })
  api.enqueueKnowledgeUploads(['first.txt', 'second.txt'], 'selected-project')
  const first = api.useKnowledgeUploads()[0]
  assert.equal(first.status, 'uploading'); assert.equal(first.loaded, 0)
  progress({ submission: first.submission, loaded: 30, total: 100 })
  assert.equal(api.useKnowledgeUploads()[0].loaded, 30)
  api.cancelKnowledgeUpload(first.submission)
  api.retryKnowledgeUpload(first.submission) // Wait for reconciliation before retrying.
  assert.equal(calls.length, 1)
  reject(Error('连接中断')); await tick()
  assert.equal(api.useKnowledgeUploads()[0].status, 'cancelled')
  assert.equal(calls.length, 2)
  complete({jobId:'second-job'}); await tick()
  api.retryKnowledgeUpload(first.submission); await tick()
  assert.equal(calls[2].submission, calls[0].submission)
  assert.equal(calls[2].project, 'selected-project')
  assert.equal(calls[1].project, 'selected-project')
  complete({jobId:'durable-job'}); await tick()
  api.retryKnowledgeUpload(first.submission); await tick()
  assert.equal(calls.length, 3)
  assert.equal(api.useKnowledgeUploads()[0].status, 'accepted')
  assert.equal(api.useKnowledgeUploads()[0].loaded, 100)
  api.enqueueKnowledgeUploads(Array(51).fill('excess.txt'))
  assert.equal(api.useKnowledgeUploads().length, 2); assert.equal(notices.length, 1)
})
