import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DatabaseZap, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { MODE_NAMES } from '@/lib/use-mode-page'
import { useSettingsStore, type AppMode } from '@/lib/store/settings'
import {
  normalizeExternalKnowledge,
  retrievalURL,
  TIMEOUT_RANGE,
  TOP_K_RANGE,
  type ExternalKnowledgeSettings,
  type ExternalKnowledgeTestResult
} from '../../../shared/external-knowledge'
import { Advanced, Field, SecretInput, SettingsCard } from './components'

const MODES: { mode: AppMode; label: string }[] = [
  { mode: 'screenshot', label: '截图' },
  { mode: 'conversation', label: '对话' }
]

/**
 * 外部知识库: a RAGFlow knowledge base, or any other service speaking Dify's
 * External Knowledge API, asked before every request of the modes ticked. Its
 * test results show here only, since this window is kept off a shared screen.
 */
export function ExternalKnowledgeCard() {
  const config = useSettingsStore((s) => s.externalKnowledge)
  // From the store, not the render: two quick edits must not both start from the same value
  const update = (
    patch: (current: ExternalKnowledgeSettings) => Partial<ExternalKnowledgeSettings>
  ) => {
    const { externalKnowledge, updateSetting } = useSettingsStore.getState()
    updateSetting(
      'externalKnowledge',
      normalizeExternalKnowledge({ ...externalKnowledge, ...patch(externalKnowledge) })
    )
  }

  let urlError = ''
  if (config.url.trim()) {
    try {
      retrievalURL(config.url)
    } catch (error) {
      urlError = error instanceof Error ? error.message : '接口地址无效'
    }
  }
  const toggleMode = (mode: AppMode) =>
    update(({ modes }) => ({
      modes: modes.includes(mode) ? modes.filter((m) => m !== mode) : [...modes, mode]
    }))

  return (
    <SettingsCard Icon={DatabaseZap} title="外部知识库">
      <div className="space-y-4">
        <p className="-mt-2 text-xs font-light leading-relaxed">
          资料多到不适合每次全文发送时，可以接入
          <ExternalLink href="https://ragflow.io/">RAGFlow</ExternalLink>
          知识库（云服务或自己部署）：每次请求前按本轮的问题检索几段资料，随请求发给
          AI，建库、解析和检索都在 RAGFlow 里完成。接口采用
          <ExternalLink href="https://docs.dify.ai/zh/cloud/use-dify/knowledge/external-knowledge-api">
            Dify 外部知识库 API
          </ExternalLink>
          的格式，实现了它的其他服务也能接。只有截图、没有文字时无从检索，这一轮不带资料；服务连不上或超时也照常作答。
        </p>

        <Field label="用于" note="勾选的模式每次请求前先检索">
          <div className="flex shrink-0 items-center gap-1">
            {MODES.map(({ mode, label }) => {
              const on = config.modes.includes(mode)
              return (
                <button
                  key={mode}
                  aria-pressed={on}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-xs transition-colors cursor-pointer',
                    on
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-white border-gray-300 text-gray-500 hover:border-blue-400'
                  )}
                  title={
                    on ? `点击后${MODE_NAMES[mode]}不再检索` : `点击后${MODE_NAMES[mode]}每次先检索`
                  }
                  onClick={() => toggleMode(mode)}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </Field>

        <Field
          label="接口地址"
          noteLayout="stacked"
          note="RAGFlow 云服务填 https://cloud.ragflow.io/api/v1/dify，自己部署的换成自己的地址"
        >
          <Input
            className="w-60 shrink-0 bg-white"
            value={config.url}
            spellCheck={false}
            aria-invalid={!!urlError}
            onChange={(e) => update(() => ({ url: e.target.value }))}
            placeholder="http://127.0.0.1/api/v1/dify"
          />
        </Field>
        {urlError && (
          <p role="alert" className="-mt-2 text-right text-xs text-red-700">
            {urlError}
          </p>
        )}

        <Field label="API Key" noteLayout="stacked" note="在 RAGFlow 的「设置 → API」里创建">
          <SecretInput
            value={config.apiKey}
            onChange={(apiKey) => update(() => ({ apiKey }))}
            placeholder="ragflow-…"
          />
        </Field>

        {/* RAGFlow refuses a request without it, so it is not folded under 高级 */}
        <Field
          label="知识库 ID"
          noteLayout="stacked"
          note="RAGFlow 必填：打开知识库，页面地址末尾那串 ID"
        >
          <Input
            className="w-60 shrink-0 bg-white"
            value={config.knowledgeId}
            spellCheck={false}
            onChange={(e) => update(() => ({ knowledgeId: e.target.value }))}
          />
        </Field>

        <Advanced>
          <Field
            label="每次最多"
            note={`${TOP_K_RANGE.min}–${TOP_K_RANGE.max} 段，合计不超过 6000 字`}
          >
            <NumberInput
              value={config.topK}
              step={1}
              suffix="段"
              onCommit={(topK) => update(() => ({ topK }))}
            />
          </Field>
          <Field label="最低相关度" note="0–1，低于它的片段不要；0 为不过滤">
            <NumberInput
              value={config.scoreThreshold}
              step={0.05}
              onCommit={(scoreThreshold) => update(() => ({ scoreThreshold }))}
            />
          </Field>
          <Field
            label="超时"
            note={`${TIMEOUT_RANGE.min / 1000}–${TIMEOUT_RANGE.max / 1000} 秒，超过就不带资料直接作答`}
          >
            <NumberInput
              value={config.timeoutMs / 1000}
              step={0.5}
              suffix="秒"
              onCommit={(seconds) => update(() => ({ timeoutMs: Math.round(seconds * 1000) }))}
            />
          </Field>
        </Advanced>

        <TestPanel config={config} disabled={!config.url.trim() || !!urlError} />
      </div>
    </SettingsCard>
  )
}

/** A link in the card's text, opened in the browser */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="px-0.5 text-blue-700 hover:underline"
    >
      {children}
    </a>
  )
}

/** A number typed freely and applied on blur or Enter, so a half-typed value is never saved */
function NumberInput({
  value,
  step,
  suffix,
  onCommit
}: {
  value: number
  step: number
  suffix?: string
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  // Show the value as saved (clamped, rounded) once it comes back
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const parsed = Number(text)
    if (text.trim() && Number.isFinite(parsed)) onCommit(parsed)
    else setText(String(value))
  }
  return (
    <div className="flex shrink-0 items-center gap-2 text-sm">
      <Input
        type="number"
        className="w-24 bg-white"
        value={text}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {/* Always there, so the boxes line up with or without a unit */}
      <span className="w-4">{suffix}</span>
    </div>
  )
}

/** One retrieval with the settings as they are now; nothing is sent to the AI */
function TestPanel({ config, disabled }: { config: ExternalKnowledgeSettings; disabled: boolean }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExternalKnowledgeTestResult | null>(null)
  // A result is about the settings it ran with; an edit or leaving the page voids it
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setResult(null)
    setBusy(false)
  }, [config])

  const run = async () => {
    const id = ++generation.current
    setBusy(true)
    setResult(null)
    try {
      const tested = await window.api.testExternalKnowledge(config, query.trim())
      if (id === generation.current) setResult(tested)
    } catch {
      if (id === generation.current)
        setResult({ ok: false, elapsedMs: 0, records: [], message: '测试失败，请重试' })
    } finally {
      if (id === generation.current) setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1 bg-white"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !disabled && query.trim() && !busy && run()}
          placeholder="输入一个问题，试试能检索到什么"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !query.trim() || busy}
          onClick={run}
        >
          {busy ? <LoaderCircle aria-label="正在检索" className="h-4 w-4 animate-spin" /> : '测试'}
        </Button>
      </div>
      {result && (
        <div role="status" className="space-y-2 rounded-md border border-gray-400/50 p-3 text-xs">
          <p className={result.ok ? 'text-green-700' : 'text-red-700'}>
            {result.ok
              ? result.records.length > 0
                ? `检索到 ${result.records.length} 段`
                : '连接正常，但没有检索到相关资料'
              : result.message}
            <span className="ml-2 text-gray-600">耗时 {result.elapsedMs} ms</span>
          </p>
          {result.records.map((record, i) => (
            <div key={i} className="rounded bg-white/50 p-2">
              <div className="mb-1 flex justify-between gap-2 text-gray-600">
                <span className="truncate">{record.title || `第 ${i + 1} 段`}</span>
                {record.score !== undefined && <span>相关度 {record.score.toFixed(2)}</span>}
              </div>
              <p className="line-clamp-4 whitespace-pre-wrap">{record.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
