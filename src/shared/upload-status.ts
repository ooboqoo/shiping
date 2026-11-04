export function uploadProcessingMessage(
  task: { status: string; error?: string },
  index: { state?: string; message?: string },
  document?: { processingStatus?: string; indexReady?: boolean }
): string {
  if (task.status === 'queued') return '等待解析'
  if (task.status === 'running') return '正在解析与清洗'
  if (task.status === 'needs_attention') {
    if (document?.indexReady) return '向量化完成 · 待人工复核，可决定保留或删除文档'
    if (index.state === 'error') return '待人工复核 · 索引失败：' + (index.message || '请重试')
    return '待人工复核 · 正在或等待向量化' + (index.message ? '：' + index.message : '')
  }
  if (task.status === 'failed') return '解析失败：' + (task.error || '请查看处理报告后重试')
  if (task.status === 'cancelled') return '解析已取消，可在处理报告中重试'
  if (task.status !== 'done') return '正在核对处理状态'
  if (index.state === 'ready' && document?.processingStatus === 'ready') return '解析完成 · 索引就绪'
  if (index.state === 'error')
    return '解析完成 · 索引失败：' + (index.message || '请到知识库管理重试')
  return '解析完成 · 等待或正在建立索引' + (index.message ? '：' + index.message : '')
}
