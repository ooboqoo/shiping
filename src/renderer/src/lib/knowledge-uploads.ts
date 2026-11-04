import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { uploadProcessingMessage } from '../../../shared/upload-status'

type Row = {
  project?: string
  path: string
  name: string
  submission: string
  loaded: number
  total: number
  status: 'queued' | 'uploading' | 'accepted' | 'failed' | 'cancelled'
  active?: boolean
  message: string
  jobId?: string
  terminal?: boolean
}
let rows: Row[] = []
let busy = false
const listeners = new Set<() => void>()
const emit = () => {
  rows = [...rows]
  listeners.forEach((fn) => fn())
}
window.api.onKnowledgeUploadProgress((value) => {
  const row = rows.find((row) => row.submission === value.submission)
  if (row) {
    Object.assign(row, value)
    emit()
  }
})
async function pump() {
  if (busy) return
  busy = true
  try {
    for (;;) {
      const row = rows.find((row) => row.status === 'queued')
      if (!row) break
      row.active = true
      row.status = 'uploading'
      row.loaded = 0
      row.message = '正在上传到所选知识库'
      emit()
      try {
        const receipt = await window.api.uploadKnowledgeFile(row.path, row.submission, row.project)
        row.status = 'accepted'
        row.jobId = receipt.jobId
        row.loaded = row.total
        row.message = '上传已接收 · 等待解析'
      } catch (e) {
        if ((row as Row).status !== 'cancelled') row.status = 'failed'
        row.message = String(e) + '；可重试核对接收记录'
      }
      row.active = false
      emit()
    }
  } finally {
    busy = false
  }
}
export function enqueueKnowledgeUploads(paths: string[], project?: string) {
  if (paths.length > 50) {
    toast.error('一次最多选择50个文件')
    return
  }
  rows.push(
    ...paths.map((path) => ({
      path,
      project,
      name: path.split(/[\\/]/).pop() || path,
      submission: crypto.randomUUID(),
      loaded: 0,
      total: 0,
      status: 'queued' as const,
      message: '等待上传'
    }))
  )
  emit()
  void pump()
}
export function useKnowledgeUploads() {
  const queue = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => rows
  )
  useEffect(() => {
    let alive = true,
      running = false
    const poll = async () => {
      if (running) return
      running = true
      try {
        for (const row of rows.filter((row) => row.jobId && !row.terminal)) {
          try {
            const { task, index, document } = await window.api.knowledgeUploadState(row.jobId!, row.project)
            if (!alive) return
            const message = uploadProcessingMessage(task, index, document)
            if (row.message !== message) window.dispatchEvent(new Event('knowledge:refresh'))
            row.message = message
            row.terminal = task.status === 'done' && index.state === 'ready' && document.processingStatus === 'ready'
          } catch (e) {
            if (alive) row.message = '状态暂时无法获取，将自动重试：' + String(e)
          }
        }
        if (alive) emit()
      } finally {
        running = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return queue
}

export function cancelKnowledgeUpload(submission: string) {
  const row = rows.find((row) => row.submission === submission)
  if (!row || !['queued', 'uploading'].includes(row.status)) return
  row.status = 'cancelled'
  row.message = row.active ? '已取消，正在核对接收记录' : '已取消'
  emit()
  void window.api.cancelKnowledgeUpload(submission).catch((e) => toast.error(String(e)))
}
export function retryKnowledgeUpload(submission: string) {
  const row = rows.find((row) => row.submission === submission)
  if (!row || row.active || !['failed', 'cancelled'].includes(row.status)) return
  row.status = 'queued'
  row.message = '等待重试'
  emit()
  void pump()
}
export function removeKnowledgeUpload(submission: string) {
  rows = rows.filter(
    (row) =>
      row.submission !== submission || row.active || !(row.terminal || row.status === 'cancelled')
  )
  emit()
}
