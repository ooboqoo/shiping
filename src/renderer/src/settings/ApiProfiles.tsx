import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/lib/store/settings'

/** Shown for a profile whose name was cleared, until the field loses focus */
const UNNAMED = '未命名配置'

/**
 * The saved AI endpoints as a row of chips, the same pattern as 使用场景: click
 * one to open it, and the panel below (`children`: URL, key, headers, model,
 * thinking switch) edits that one. Which profile a mode sends its requests with
 * is picked separately (「用于」 below, or the mode's own settings group); the
 * chips carry a tag for each mode using them.
 */
export function ApiProfiles({ children }: { children: ReactNode }) {
  const {
    apiProfiles,
    activeProfileId,
    screenshotProfileId,
    conversationProfileId,
    setActiveProfile,
    addProfile,
    removeProfile
  } = useSettingsStore()
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [copyActive, setCopyActive] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const active = apiProfiles.find((p) => p.id === activeProfileId)
  const activeName = active?.name.trim() || UNNAMED
  // Removing a profile in use hands its modes to the neighbour, like removeProfile does
  const activeIndex = apiProfiles.findIndex((p) => p.id === activeProfileId)
  const successor = apiProfiles.filter((p) => p.id !== activeProfileId)[
    Math.min(activeIndex, apiProfiles.length - 2)
  ]
  const usedBy = [
    screenshotProfileId === activeProfileId && '截图模式',
    conversationProfileId === activeProfileId && '对话模式'
  ].filter(Boolean)

  const handleAdd = () => {
    const trimmed = newName.trim()
    addProfile(trimmed || `配置${apiProfiles.length + 1}`, copyActive)
    setNewName('')
    setCopyActive(false)
    setAddOpen(false)
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {apiProfiles.map((profile) => (
          <button
            key={profile.id}
            className={cn(
              'max-w-48 truncate rounded-full border px-3 py-1 text-sm transition-colors cursor-pointer select-none',
              profile.id === activeProfileId
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white border-gray-300 hover:border-blue-400'
            )}
            onClick={() => setActiveProfile(profile.id)}
          >
            {profile.name.trim() || UNNAMED}
            {profile.id === screenshotProfileId && <ModeTag>截图</ModeTag>}
            {profile.id === conversationProfileId && <ModeTag>对话</ModeTag>}
          </button>
        ))}
        <button
          className="flex items-center gap-1 rounded-full border border-dashed border-gray-400 bg-transparent px-3 py-1 text-sm text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          新增配置
        </button>
      </div>

      <div className="mt-3 space-y-4 rounded-md border border-gray-400/60 bg-white/25 p-4">
        <ProfileNameField />

        <ProfileUsageField />

        {children}

        {apiProfiles.length > 1 && (
          <div className="flex justify-end">
            <button
              className="flex items-center gap-1 text-xs text-gray-600 hover:text-red-600 transition-colors"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3 w-3" />
              删除此配置
            </button>
          </div>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新增配置</DialogTitle>
            <DialogDescription>
              每个配置单独保存 API
              地址、密钥、请求头、模型和思考开关；截图模式和对话模式各选一个来用，也可用快捷键切换
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="如「DeepSeek 主力」，留空则自动命名"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={copyActive}
              onCheckedChange={(checked) => setCopyActive(checked === true)}
            />
            <span className="min-w-0 truncate">复制「{activeName}」的设置</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button onClick={handleAdd}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除配置</DialogTitle>
            <DialogDescription>
              确定删除配置「{activeName}」吗？其中的 API Key 等设置将一并删除，且无法恢复。
              {usedBy.length > 0 &&
                successor &&
                `${usedBy.join('和')}正在使用它，删除后改用「${successor.name.trim() || UNNAMED}」。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                removeProfile(activeProfileId)
                setDeleteOpen(false)
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ModeTag({ children }: { children: ReactNode }) {
  return <span className="ml-1.5 rounded bg-black/15 px-1 text-[10px] leading-4">{children}</span>
}

/** Which modes send their requests with the profile being edited */
function ProfileUsageField() {
  const { activeProfileId, screenshotProfileId, conversationProfileId, setModeProfile } =
    useSettingsStore()
  const profile = useSettingsStore((s) => s.apiProfiles.find((p) => p.id === activeProfileId))
  if (!profile) return null

  const modes = [
    { mode: 'screenshot' as const, label: '截图模式', inUse: screenshotProfileId === profile.id },
    {
      mode: 'conversation' as const,
      label: '对话模式',
      inUse: conversationProfileId === profile.id
    }
  ]
  // A mode always has a profile, so the one in use is switched off by picking another
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm font-medium">
        用于
        <span className="ml-2 text-xs font-light">
          点击让该模式改用这个配置；截图模式需要能识图的模型，对话模式适合关闭思考的快模型
        </span>
      </label>
      <div className="flex w-60 shrink-0 gap-2">
        {modes.map(({ mode, label, inUse }) => {
          const noImages = mode === 'screenshot' && profile.vision === false
          return (
            <button
              key={mode}
              disabled={inUse || noImages}
              className={cn(
                'flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors',
                inUse
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : noImages
                    ? 'bg-white/50 border-gray-300 text-gray-400'
                    : 'bg-white border-gray-300 hover:border-blue-400 cursor-pointer'
              )}
              onClick={() => setModeProfile(mode, profile.id)}
            >
              {inUse ? `${label}使用中` : noImages ? '不支持识图' : `用于${label}`}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The active profile's name, edited in place like the fields below it */
function ProfileNameField() {
  const { apiProfiles, activeProfileId, renameProfile } = useSettingsStore()
  const index = apiProfiles.findIndex((p) => p.id === activeProfileId)
  const profile = apiProfiles[index]
  if (!profile) return null

  return (
    <div className="flex items-center justify-between">
      <label className="text-sm font-medium">
        配置名称
        <span className="ml-2 text-xs font-light">用快捷键切换配置时会提示这个名称</span>
      </label>
      <input
        value={profile.name}
        onChange={(e) => renameProfile(profile.id, e.target.value)}
        // Spaces are kept while typing, so tidy up once the user moves on
        onBlur={() => {
          const trimmed = profile.name.trim()
          if (trimmed !== profile.name || !trimmed) {
            renameProfile(profile.id, trimmed || `配置${index + 1}`)
          }
        }}
        className="w-60 px-3 py-2 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder="如「DeepSeek 主力」"
        maxLength={30}
      />
    </div>
  )
}

/**
 * Edits are saved the moment they are typed, so there is no button to press.
 * This reports that back instead: while a field is changing it reads 「保存中」,
 * and once typing stops it confirms 「已保存」 for a moment. Without it the
 * silence is indistinguishable from a failed save.
 *
 * It sits in the section title so appearing never pushes the fields around.
 */
export function ApiSaveStatus() {
  const activeProfileId = useSettingsStore((s) => s.activeProfileId)
  // Switching, adding or removing a profile only loads other values; starting
  // afresh keeps that from reading as a save
  return <SaveStatus key={activeProfileId} />
}

function SaveStatus() {
  const profile = useSettingsStore((s) => s.apiProfiles.find((p) => p.id === s.activeProfileId))
  const snapshot = JSON.stringify([
    profile?.name,
    profile?.apiBaseURL,
    profile?.apiKey,
    profile?.apiHeaders,
    profile?.model,
    profile?.disableThinking,
    profile?.reasoningEffort
  ])
  const lastSnapshot = useRef(snapshot)
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')

  useEffect(() => {
    // Only an edit counts: mounting (and StrictMode's re-run) sees the same values
    if (snapshot === lastSnapshot.current) return
    lastSnapshot.current = snapshot
    setState('saving')
    const saving = setTimeout(() => setState('saved'), 400)
    // The confirmation is a reaction to an edit, not a permanent label
    const done = setTimeout(() => setState('idle'), 2400)
    return () => {
      clearTimeout(saving)
      clearTimeout(done)
    }
  }, [snapshot])

  if (state === 'idle') return null

  return (
    <span className="ml-auto flex items-center gap-1 text-xs font-normal">
      {state === 'saving' ? (
        <span className="text-gray-500">保存中…</span>
      ) : (
        <span className="flex items-center gap-1 text-green-700">
          <Check className="h-3.5 w-3.5" />
          已保存
        </span>
      )}
    </span>
  )
}
