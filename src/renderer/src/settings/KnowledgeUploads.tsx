import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  useKnowledgeUploads,
  cancelKnowledgeUpload,
  retryKnowledgeUpload,
  removeKnowledgeUpload
} from '../lib/knowledge-uploads'

export function KnowledgeUploads() {
  const queue = useKnowledgeUploads()
  if (!queue.length) return null
  return (
    <div className="mb-4 space-y-2" aria-label="文件上传与处理状态">
      {queue.map((row) => (
        <div key={row.submission} className="rounded border bg-white/60 p-3 text-xs">
          <strong>{row.name}</strong>
          <p role="status">{row.message}</p>
          <div className="flex flex-wrap items-center gap-2">
            <progress
              className="flex-1"
              max={100}
              value={
                row.status === 'accepted'
                  ? 100
                  : row.total
                    ? Math.min(99, (row.loaded / row.total) * 100)
                    : 0
              }
              aria-label={row.name + '上传进度'}
            />
            <span>
              {row.loaded.toLocaleString()} / {row.total ? row.total.toLocaleString() : '—'} 字节
              {row.status === 'accepted'
                ? ' · 上传100%'
                : row.total
                  ? ` · ${Math.min(99, Math.floor((row.loaded / row.total) * 100))}%`
                  : ''}
            </span>
            {['queued', 'uploading'].includes(row.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  cancelKnowledgeUpload(row.submission)
                }}
              >
                取消
              </Button>
            )}
            {!row.active && ['failed', 'cancelled'].includes(row.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  retryKnowledgeUpload(row.submission)
                }}
              >
                重试上传
              </Button>
            )}
            {row.jobId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void window.api.openLibraryManager(row.jobId).catch((e) => toast.error(String(e)))
                }
              >
                处理报告 / 重试任务
              </Button>
            )}
            {(row.terminal || (row.status === 'cancelled' && !row.active)) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  removeKnowledgeUpload(row.submission)
                }}
              >
                移除记录
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
