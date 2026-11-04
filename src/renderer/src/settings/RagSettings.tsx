import { useEffect, useState } from 'react'
import { Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/lib/store/settings'
import { SettingsCard } from './components'
import type { RagHit, RagStatus } from '../../../shared/rag'
export function RagSettings() {
  const mode = useSettingsStore((s) => s.ragConfig.mode),
    update = useSettingsStore((s) => s.updateSetting)
  const [status, setStatus] = useState<RagStatus>(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [hits, setHits] = useState<RagHit[]>([]),
    [previewMode, setPreviewMode] = useState<'conversation' | 'screenshot'>('conversation')
  const refresh = () =>
    window.api
      .ragStatus()
      .then(setStatus)
      .catch((e) => setMessage(String(e)))
  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(t)
  }, [])
  async function run(task: () => Promise<unknown>) {
    setBusy(true)
    setMessage('')
    try {
      await task()
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCard Icon={Database} title="资料检索">
      <p className="text-sm text-muted-foreground">
        全文模式会随请求发送启用资料；向量检索仅发送命中片段。资料和索引保存在本机，向量由 AI
        模型中配置的模型生成，命中片段会交给所选 AI 平台。
      </p>
      <div className="flex flex-wrap gap-2 my-3">
        <Button
          aria-pressed={mode === 'full'}
          variant={mode === 'full' ? 'default' : 'outline'}
          onClick={() => update('ragConfig', { mode: 'full' })}
        >
          全文模式
        </Button>
        <Button
          disabled={busy || status?.state !== 'ready'}
          aria-pressed={mode === 'local'}
          variant={mode === 'local' ? 'default' : 'outline'}
          onClick={() => update('ragConfig', { mode: 'local' })}
        >
          向量检索
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setMessage(await window.api.ragCheck())
            })
          }
        >
          检查知识库
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => window.api.ragRebuild())}
        >
          建立 / 更新索引
        </Button>
      </div>
      <p className="text-sm">
        当前模式：{mode === 'local' ? '向量检索' : '全文'} ·{' '}
        {busy ? '处理中，请稍候。' : (status?.message ?? '读取状态中')} · {status?.documents ?? 0}{' '}
        份资料 · {status?.chunks ?? 0} 个片段
      </p>
      <p className="text-sm text-muted-foreground">
        知识库服务由应用自动启动。结构化分片优先保留章节、段落和链接。请先在 AI
        模型中完成向量模型配置，再建立索引。纯图片首轮没有文字检索输入，不附加资料；对话、转录和文字追问可检索。
      </p>
      <div className="flex gap-2 my-3">
        <select
          aria-label="检索预览模式"
          value={previewMode}
          onChange={(e) => setPreviewMode(e.target.value as typeof previewMode)}
          className="bg-background border rounded px-2"
        >
          <option value="conversation">对话资料</option>
          <option value="screenshot">截图资料</option>
        </select>
        <Input
          aria-label="检索预览问题"
          value={query}
          maxLength={3000}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入准备好的问题，查看命中依据"
        />
        <Button
          disabled={busy || !query.trim()}
          onClick={() =>
            void run(async () => setHits(await window.api.ragPreview(previewMode, query)))
          }
        >
          预览
        </Button>
      </div>
      {hits.slice(0, 6).map((h) => (
        <div key={h.id} className="border rounded p-2 my-2 text-sm">
          <strong>
            {h.name} · {h.start}–{h.end}
          </strong>
          <p className="text-muted-foreground">{h.section || '未识别到章节'}</p>
          <p className="whitespace-pre-wrap">{h.text}</p>
        </div>
      ))}
      {message && (
        <p role="status" className="text-sm whitespace-pre-wrap">
          {message}
        </p>
      )}
    </SettingsCard>
  )
}
