const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
test('upload state separates parsing, attention, index waiting and completion', () => {
  const { uploadProcessingMessage: message } = load('src/shared/upload-status.ts')
  assert.match(message({ status: 'running' }, {}), /解析/)
  assert.match(message({ status: 'needs_attention' }, {}), /复核/)
  assert.match(message({ status: 'failed', error: '坏文件' }, {}), /坏文件/)
  assert.match(
    message({ status: 'done' }, { state: 'indexing', message: '请先配置Embedding模型' }),
    /Embedding/
  )
  assert.match(message({ status: 'done' }, { state: 'ready' }, { processingStatus: 'ready' }), /索引就绪/)
  assert.doesNotMatch(message({ status: 'running' }, { state: 'ready' }), /索引就绪/)
})
test('an older ready index cannot mark the new document revision complete', () => {
  const { uploadProcessingMessage: message } = load('src/shared/upload-status.ts')
  assert.doesNotMatch(message({status:'done'}, {state:'ready'}, {processingStatus:'waiting_index'}), /索引就绪/)
})

test('review warnings retain the indexing outcome', () => {
 const {uploadProcessingMessage: message}=load('src/shared/upload-status.ts')
 assert.match(message({status:'needs_attention'}, {state:'ready'}, {indexReady:true}), /向量化完成.*复核/)
 assert.doesNotMatch(message({status:'needs_attention'}, {state:'ready'}, {indexReady:false}), /向量化完成/)
})
