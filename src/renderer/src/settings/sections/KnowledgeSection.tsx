import { KnowledgeUploads } from '../KnowledgeUploads'
import { enqueueKnowledgeUploads } from '../../lib/knowledge-uploads'
import { LibraryRerankSwitch } from '../LibraryModelSettings'
import { useSettingsStore } from '@/lib/store/settings'
import { RagSettings } from '../RagSettings'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  FileText,
  FileUp,
  LibraryBig,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { MODE_NAMES } from '@/lib/use-mode-page'
import type { AppMode } from '@/lib/store/settings'
import {
  formatChars,
  formatTokens,
  knowledgeUsage,
  useKnowledgeDocs,
  KNOWLEDGE_CHAR_LIMIT,
  type KnowledgeDoc
} from '@/lib/knowledge'
import { SettingsCard } from '../components'
import { mergeKnowledgeDocs } from '../../../../shared/knowledge'

const MODES: { mode: AppMode; label: string }[] = [
  { mode: 'screenshot', label: '截图' },
  { mode: 'conversation', label: '对话' }
]

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

/**
 * 资料库: material the AI should draw on (resume, prepared Q&A, notes). Main
 * keeps it on disk; each piece is sent with the modes ticked on it, in front of
 * that mode's system prompt. Files can be picked or dropped anywhere here.
 */
export function KnowledgeSection() {
  const local = useSettingsStore((s) => s.ragConfig.mode === 'local')
  const [docs, setDocs] = useKnowledgeDocs()
  const [libraries, setLibraries] = useState<{id: string; name: string}[]>([])
  const [selected, setSelected] = useState('')
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    const read = () => window.api.listKnowledgeLibraries().then((result) => {
      setLibraries(result.libraries)
      setSelected(result.selected)
    }).catch((error) => toast.error('无法读取知识库', {description: String(error)}))
    void read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [])
  const [editing, setEditing] = useState<KnowledgeDoc | 'new' | null>(null)
  const [deleting, setDeleting] = useState<KnowledgeDoc | null>(null)
  const [dragging, setDragging] = useState(false)
  const [selectingFiles, setSelectingFiles] = useState(false)
  const selectingFilesRef = useRef(false)
  // dragenter / dragleave fire for every child crossed; only the outermost pair counts
  const dragDepth = useRef(0)

  // A file dropped beside the drop zone would otherwise replace the app with the file
  useEffect(() => {
    const block = (e: Event) => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const replaceDoc = (doc: KnowledgeDoc) =>
    setDocs((list) => list?.map((d) => (d.id === doc.id ? doc : d)) ?? null)

  const toggleMode = async (doc: KnowledgeDoc, mode: AppMode) => {
    const on = doc.modes.includes(mode)
    const modes = MODES.map((m) => m.mode).filter((m) => (m === mode ? !on : doc.modes.includes(m)))
    try {
      const saved = await window.api.updateKnowledge(doc.id, { modes, version: doc.version })
      if (saved) replaceDoc(saved)
    } catch (error) {
      setDocs(await window.api.listKnowledge())
      toast.error('资料已变化，请刷新后重试', { description: String(error) })
    }
  }

  const reimport = async (doc: KnowledgeDoc) => {
    if (
      !window.confirm(
        '重新解析会创建新版本，成功后替换当前内容。若曾人工修改，请先下载保留。确认重新解析原件？'
      )
    )
      return
    const { doc: updated, error } = await window.api.reimportKnowledge(doc.id, doc.version)
    if (updated) {
      replaceDoc(updated)
      toast.success(`已提交「${doc.source}」后台处理`)
    } else {
      toast.error('重新导入失败', { description: error })
    }
  }

  const remove = async (doc: KnowledgeDoc) => {
    setDeleting(null)
    try {
      await window.api.removeKnowledge(doc.id, doc.version)
      setDocs((list) => list?.filter((d) => d.id !== doc.id) ?? null)
    } catch (error) {
      setDocs(await window.api.listKnowledge())
      toast.error('资料已变化，未执行移除', { description: String(error) })
    }
  }

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current++
      setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: async (e: DragEvent) => {
      dragDepth.current = 0
      setDragging(false)
      const paths = [...e.dataTransfer.files]
        .map((file) => window.api.getPathForFile(file))
        .filter(Boolean)
      if (paths.length > 0) {
        enqueueKnowledgeUploads(paths, selected)
      }
    }
  }

  return (
    <div className="relative" {...dropHandlers}>
      <SettingsCard Icon={LibraryBig} title={`知识库 · ${libraries.find((item) => item.id === selected)?.name || '加载中'}`}>
        <div className="mb-4">
          <p className="mb-2 text-sm">选择知识库（上传、资料列表与 AI 检索共用）</p>
          <div className="flex flex-wrap gap-2">
            {libraries.map((item) => <Button key={item.id} variant="outline" disabled={switching || selectingFiles}
              aria-pressed={selected === item.id}
              className={selected === item.id ? 'border-blue-500 bg-blue-50 text-blue-800' : 'bg-white'}
              onClick={async () => {
                if (selected === item.id) return
                setSwitching(true)
                try {
                  await window.api.selectKnowledgeLibrary(item.id)
                  setSelected(item.id)
                  setEditing(null)
                  setDeleting(null)
                  setDocs(await window.api.listKnowledge())
                  window.dispatchEvent(new Event('knowledge:refresh'))
                } catch (error) { toast.error('切换失败', {description: String(error)}) }
                finally { setSwitching(false) }
              }}>{item.name}</Button>)}
          </div>
        </div>
        <p className="-mt-2 mb-4 text-xs font-light">
          导入简历、准备好的问答、笔记等资料，AI
          作答时会优先参考；每份资料可以分别选择用于截图模式、对话模式。
          {local
            ? '本地检索模式仅发送命中的资料片段，不会每次发送全文。'
            : '全文模式会随每次请求发送该模式启用的全部资料。'}
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={selectingFiles || switching || !selected}
            onClick={async () => {
              if (selectingFilesRef.current) return
              selectingFilesRef.current = true
              setSelectingFiles(true)
              try {
                enqueueKnowledgeUploads(await window.api.selectKnowledgeFiles(), selected)
              } catch (error) {
                toast.error('无法选择文件', { description: String(error) })
              } finally {
                selectingFilesRef.current = false
                setSelectingFiles(false)
              }
            }}
          >
            <FileUp className="h-4 w-4" />
            {selectingFiles ? '正在选择文件…' : '上传文件到当前库'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="bg-white"
            onClick={() => setEditing('new')}
          >
            <Plus className="h-4 w-4" />
            新建文本
          </Button>
          <span className="text-xs font-light">
            每个文件不超过30MB，每批最多50个。上传后自动解析、清洗和建立索引；需要复核或模型配置时会显示提示。支持
            PDF、DOCX、Markdown、TXT、图片、XLSX、PPTX，也可拖入文件。其他知识库请打开知识库管理后选择。
          </span>
        </div>

        <Button
          variant="link"
          onClick={() =>
            void window.api
              .openLibraryManager()
              .catch((error) => toast.error('无法打开知识库管理', { description: String(error) }))
          }
        >
          打开本机知识库管理与清洗报告
        </Button>

        <KnowledgeUploads />

        {docs && docs.length === 0 && (
          <div className="rounded-md border border-dashed border-gray-400 px-4 py-6 text-center text-sm text-gray-600">
            还没有资料。可以导入简历（PDF / Word），或把准备好的问答粘贴成一份文本
          </div>
        )}

        {docs && docs.length > 0 && (
          <>
            <ul className="space-y-2">
              {docs.map((doc) => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  onToggleMode={(mode) => toggleMode(doc, mode)}
                  onEdit={() => setEditing(doc)}
                  onReimport={() => reimport(doc)}
                  onDelete={() => setDeleting(doc)}
                />
              ))}
            </ul>
            <UsageMeter docs={docs} />
          </>
        )}
      </SettingsCard>
      <div className="mt-6">
        <RagSettings />
      </div>
      <div className="my-4">
        <LibraryRerankSwitch />
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500 bg-blue-50/80 text-sm font-medium text-blue-700">
          松开鼠标导入资料
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <DocEditor
            key={editing === 'new' ? 'new' : editing.id}
            target={editing}
            onClose={() => setEditing(null)}
            onSaved={(doc) =>
              editing === 'new'
                ? setDocs((list) => mergeKnowledgeDocs(list ?? [], [doc]))
                : replaceDoc(doc)
            }
          />
        )}
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>移入回收站</DialogTitle>
            <DialogDescription>
              确定将资料「{deleting?.name}
              」移入回收站吗？原文和源文件仍保留，可在本地管理网页中恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => deleting && remove(deleting)}>
              移入回收站
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DocRow({
  doc,
  onToggleMode,
  onEdit,
  onReimport,
  onDelete
}: {
  doc: KnowledgeDoc
  onToggleMode: (mode: AppMode) => void
  onEdit: () => void
  onReimport: () => void
  onDelete: () => void
}) {
  const meta = [doc.source && `来自 ${doc.source}`, formatChars(doc.chars)]
  if (doc.modes.length === 0) meta.push('未启用')

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-gray-400/60 bg-white/40 px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-gray-600" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{doc.name}</div>
        <div className="truncate text-xs text-gray-600">{meta.filter(Boolean).join(' · ')}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {MODES.map(({ mode, label }) => {
          const on = doc.modes.includes(mode)
          return (
            <button
              key={mode}
              className={cn(
                'rounded-md border px-2 py-0.5 text-xs transition-colors cursor-pointer',
                on
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-white border-gray-300 text-gray-500 hover:border-blue-400'
              )}
              title={on ? `点击后不再用于${MODE_NAMES[mode]}` : `点击用于${MODE_NAMES[mode]}`}
              onClick={() => onToggleMode(mode)}
            >
              {label}
            </button>
          )
        })}
        <RowAction title="查看 / 编辑文字" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </RowAction>
        {doc.sourcePath ? (
          <RowAction title="从原文件重新导入（会覆盖在这里做的修改）" onClick={onReimport}>
            <RefreshCw className="h-3.5 w-3.5" />
          </RowAction>
        ) : (
          // Pasted text has nothing to reimport; keep the columns lined up with the rows that do
          <span className="w-6.5" />
        )}
        <RowAction title="删除" onClick={onDelete} danger>
          <Trash2 className="h-3.5 w-3.5" />
        </RowAction>
      </div>
    </li>
  )
}

function RowAction({
  title,
  onClick,
  danger,
  children
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      className={cn(
        'rounded p-1.5 text-gray-600 transition-colors cursor-pointer hover:bg-black/10',
        danger ? 'hover:text-red-600' : 'hover:text-gray-900'
      )}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** How much each mode sends with every request, against the suggested limit */
function UsageMeter({ docs }: { docs: KnowledgeDoc[] }) {
  const local = useSettingsStore((s) => s.ragConfig.mode === 'local')
  const usages = MODES.map(({ mode }) => ({ mode, ...knowledgeUsage(docs, mode) }))

  return (
    <div className="mt-4 space-y-2">
      {usages.map(({ mode, count, chars, tokens, over }) => (
        <div key={mode}>
          <div className="mb-1 flex justify-between gap-2 text-xs">
            <span>
              {MODE_NAMES[mode]}
              {local ? '可检索资料' : '每次请求带上'}
            </span>
            <span className={over ? 'font-medium text-amber-800' : 'text-gray-600'}>
              {count > 0
                ? `${count} 份 · ${formatChars(chars)}（${formatTokens(tokens)}）`
                : '不带资料'}
              <span className="text-gray-500">
                {' '}
                {local
                  ? ' / 每次最多选取 6 段、总计 6000 字'
                  : ` / 建议不超过 ${formatChars(KNOWLEDGE_CHAR_LIMIT)}`}
              </span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
            <div
              className={cn('h-full rounded-full', over ? 'bg-amber-600' : 'bg-blue-600')}
              style={{ width: `${Math.min(100, (chars / KNOWLEDGE_CHAR_LIMIT) * 100)}%` }}
            />
          </div>
        </div>
      ))}
      {!local && usages.some((u) => u.over) && (
        <p className="flex items-start gap-1 text-xs text-amber-800">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            超过建议上限：每次请求都会带上全部资料，回答会变慢、费用更高，模型处理不了这么长时请求会失败。可以删掉资料里用不到的部分，或让部分资料不用于该模式
          </span>
        </p>
      )}
    </div>
  )
}

/** Paste a new piece of material, or view and correct one (a PDF's layout often needs it) */
function DocEditor({
  target,
  onClose,
  onSaved
}: {
  target: KnowledgeDoc | 'new'
  onClose: () => void
  onSaved: (doc: KnowledgeDoc) => void
}) {
  const isNew = target === 'new'
  const [name, setName] = useState(isNew ? '' : target.name)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState<string | undefined>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (target === 'new') return
    let alive = true
    window.api
      .getKnowledgeDocument(target.id)
      .then((saved) => {
        if (!alive) return
        setName(saved.doc.name)
        setText(saved.text)
        setVersion(saved.doc.version)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setLoading(false)
        toast.error('资料无法加载，请关闭后重新打开')
      })
    return () => {
      alive = false
    }
  }, [target])

  const save = async () => {
    setSaving(true)
    try {
      const doc = isNew
        ? await window.api.createKnowledge(name, text)
        : await window.api.updateKnowledge(target.id, { name, text, version })
      if (!mounted.current) return
      if (doc) onSaved(doc)
      onClose()
    } catch {
      if (mounted.current)
        toast.error('未保存：资料可能已在其他位置变化', {
          description: '当前编辑仍保留，请复制需要的内容，重新打开资料后合并。'
        })
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{isNew ? '新建文本' : '编辑资料'}</DialogTitle>
        <DialogDescription>
          {isNew
            ? '粘贴简历、岗位 JD、准备好的问答或笔记；保存后随时可以修改'
            : '这是发给 AI 的文字，可以删掉无关内容、修正排版错乱；保存后从下一次请求开始生效'}
        </DialogDescription>
      </DialogHeader>
      <Input
        disabled={loading || saving}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="资料名称，如「我的简历」「八股问答」，AI 会看到这个名称"
        maxLength={40}
        autoFocus={isNew}
      />
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={loading || saving}
        placeholder={
          loading
            ? '读取中…'
            : '在这里粘贴内容。问答可以写成：\n问：为什么从上一家公司离职？\n答：……'
        }
        className="max-h-[50vh] min-h-48 bg-white overflow-y-auto"
      />
      <DialogFooter className="items-center sm:justify-between">
        <span className="text-xs text-gray-600">{formatChars(text.trim().length)}</span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={save}
            disabled={loading || saving || !text.trim() || (!isNew && !version)}
          >
            保存
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  )
}
