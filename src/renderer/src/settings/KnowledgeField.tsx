import { cn } from '@/lib/utils'
import { useSettingsStore, type AppMode } from '@/lib/store/settings'
import { formatChars, knowledgeUsage, useKnowledgeDocs } from '@/lib/knowledge'
import { Field } from './components'

/** A mode's share of the 资料库, with the way to it; the material itself is managed there */
export function KnowledgeField({ mode, onOpen }: { mode: AppMode; onOpen: () => void }) {
  const local = useSettingsStore((s) => s.ragConfig.mode === 'local')
  const [docs] = useKnowledgeDocs()
  const usage = docs && knowledgeUsage(docs, mode)

  return (
    <Field
      label="参考资料"
      note={
        local
          ? '本地检索从该模式启用的资料中选取相关片段，再交给 AI 参考'
          : '全文模式会随每次请求发送该模式启用的资料'
      }
    >
      <button
        className={cn(
          'max-w-60 shrink-0 truncate text-xs transition-colors cursor-pointer hover:underline',
          !local && usage?.over ? 'text-amber-800' : 'text-blue-700'
        )}
        onClick={onOpen}
      >
        {!usage
          ? ''
          : usage.count > 0
            ? `${usage.count} 份 · ${formatChars(usage.chars)}${!local && usage.over ? '（超过建议上限）' : ''}`
            : '未使用，去资料库添加'}
      </button>
    </Field>
  )
}
