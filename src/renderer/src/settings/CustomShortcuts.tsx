import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { isModifierKey, getShortcutAccelerator } from '@/lib/utils/keyboard'
import { useShortcutsStore, type Shortcut as StoredShortcut } from '@/lib/store/shortcuts'
import { useSettingsStore } from '@/lib/store/settings'

const ShortcutsContext = createContext<{
  recordingAction: string | null
  setRecordingAction: (action: string | null) => void
  /** Actions whose key another app holds */
  failed: Set<string>
}>({
  recordingAction: null,
  setRecordingAction: () => {},
  failed: new Set()
})

/**
 * The actions whose key another app holds, as main finds when it tries them.
 * Asked again whenever a binding changes, a moment later: main applies it first
 */
function useFailedShortcuts(shortcuts: Record<string, StoredShortcut>): Set<string> {
  const [failed, setFailed] = useState<Set<string>>(new Set())
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.api.getShortcuts().then((status) => {
        setFailed(
          new Set(
            Object.values(status)
              .filter((shortcut) => shortcut.status === 'failed')
              .map((shortcut) => shortcut.action)
          )
        )
      })
    }, 100)
    return () => clearTimeout(timer)
  }, [shortcuts])
  return failed
}

export function CustomShortcuts() {
  const { shortcuts, updateShortcut } = useShortcutsStore()
  const { dashscopeApiKey } = useSettingsStore()
  const [recordingAction, setRecordingAction] = useState<string | null>(null)
  const failed = useFailedShortcuts(shortcuts)

  const onShortcutChange = useCallback(
    (action: string, key: string) => {
      const newShortcut = { ...shortcuts[action], key }
      updateShortcut(action, newShortcut)
      window.api.updateShortcuts([newShortcut])
    },
    [shortcuts, updateShortcut]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recordingAction) return

      e.preventDefault()

      if (isModifierKey(e.code)) return
      const accelerator = getShortcutAccelerator(e)
      // User press escape to cancel recording.
      if (e.code === 'Escape' && !accelerator) {
        setRecordingAction(null)
      }
      // A bare Backspace / Delete leaves the action without a key
      if ((e.code === 'Backspace' || e.code === 'Delete') && !accelerator) {
        onShortcutChange(recordingAction, '')
        setRecordingAction(null)
      }
      if (!accelerator) return
      onShortcutChange(recordingAction, accelerator)
      setRecordingAction(null)
    },
    [recordingAction, onShortcutChange]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleKeyDown])

  // Main lets go of every key while one is recorded: a held key never reaches this page
  const recording = recordingAction !== null
  useEffect(() => {
    if (!recording) return
    void window.api.setShortcutRecording(true)
    return () => {
      void window.api.setShortcutRecording(false)
    }
  }, [recording])

  return (
    <ShortcutsContext.Provider value={{ recordingAction, setRecordingAction, failed }}>
      <div className="space-y-4">
        {/* Window Management */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500">窗口管理</h3>
          <Shortcut label="隐藏/显示窗口" shortcut="hideOrShowMainWindow" />
          <Shortcut
            label="切换模式"
            description="在截图模式和对话模式之间切换"
            shortcut="switchMode"
          />
          <Shortcut
            label="鼠标穿透"
            description="启用后窗口对鼠标穿透，可以点击窗口背后的内容"
            shortcut="ignoreOrEnableMouse"
          />
          <Shortcut
            label="提高不透明度"
            description="每次调整 5%，窗口更清晰"
            shortcut="increaseOpacity"
          />
          <Shortcut
            label="提高透明度"
            description="每次调整 5%，窗口更透明"
            shortcut="decreaseOpacity"
          />
        </div>

        {/* Screenshot mode */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500">截图模式</h3>
          <Shortcut
            label="截图"
            description="截图并生成解题建议（会新开对话）"
            shortcut="takeScreenshot"
          />
          <Shortcut
            label="框选识别"
            description="拖出一块区域，松开鼠标即截图并生成解题建议（会新开对话）；只截这一次，不改变截图区域"
            shortcut="snipScreenshot"
          />
          <Shortcut
            label="追加截图"
            description="在当前对话中追加截图并生成解题建议，适用于长题目等场景"
            shortcut="appendScreenshot"
          />
          <Shortcut
            label="框选截图区域"
            description="重新框选截图时只截的区域，Enter 确认、Esc 取消"
            shortcut="pickCaptureRegion"
          />
        </div>

        {/* Conversation mode */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500">对话模式</h3>
          <Shortcut
            label="出提示"
            description="立即出提示，不等对方说完；没有新内容时换个说法重出"
            shortcut="generateHint"
          />
          <Shortcut
            label="切换自动/手动"
            description="自动：对方说完一句就出提示；手动：只在按「出提示」时出"
            shortcut="toggleHintMode"
          />
        </div>

        {/* Both modes */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500">两种模式通用（作用于当前模式）</h3>
          <Shortcut
            label="停止生成"
            description="打断正在生成的解题建议或提示"
            shortcut="stopSolutionStream"
          />
          <Shortcut
            label="上一个模型"
            description="当前模式切换到上一个已保存的 AI 配置"
            shortcut="previousApiProfile"
          />
          <Shortcut
            label="下一个模型"
            description="当前模式切换到下一个已保存的 AI 配置"
            shortcut="nextApiProfile"
          />
          <Shortcut
            label="切换提示词场景"
            description="在当前模式的场景间依次切换；从下次提问开始生效，不清空当前对话"
            shortcut="cycleScene"
          />
          <Shortcut
            label="语音转录"
            description="截图模式：开始/暂停转录；对话模式：开始/停止监听对方说话"
            shortcut="toggleTranscription"
            disabled={!dashscopeApiKey}
          />
          <Shortcut
            label="清除转录"
            description="截图模式：清除未提交的转录文本；对话模式：清空整段对话和提示"
            shortcut="clearTranscription"
            disabled={!dashscopeApiKey}
          />
        </div>

        {/* Navigation */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500">页面导航</h3>
          <Shortcut label="向上翻页" shortcut="pageUp" />
          <Shortcut label="向下翻页" shortcut="pageDown" />
        </div>

        {/* Window Movement */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500">窗口移动</h3>
          <Shortcut label="向上移动窗口" shortcut="moveMainWindowUp" />
          <Shortcut label="向下移动窗口" shortcut="moveMainWindowDown" />
          <Shortcut label="向左移动窗口" shortcut="moveMainWindowLeft" />
          <Shortcut label="向右移动窗口" shortcut="moveMainWindowRight" />
        </div>
      </div>
    </ShortcutsContext.Provider>
  )
}

function Shortcut({
  label,
  description,
  shortcut: shortcutAction,
  disabled
}: {
  label: string
  description?: string
  shortcut: string
  disabled?: boolean
}) {
  const { shortcuts } = useShortcutsStore()
  const { recordingAction, setRecordingAction, failed } = useContext(ShortcutsContext)
  const shortcut = shortcuts[shortcutAction]
  const isRecording = recordingAction === shortcutAction

  return shortcut ? (
    <div
      className={`flex items-center justify-between${disabled ? ' opacity-40 pointer-events-none' : ''}`}
    >
      <div className="flex gap-2 items-center">
        <label className="text-sm font-medium">{label}</label>
        {description && <p className="text-xs font-light">{description}</p>}
      </div>
      <span
        className="flex shrink-0 items-center gap-2 cursor-pointer"
        onClick={() => setRecordingAction(isRecording ? null : shortcutAction)}
      >
        {!isRecording && failed.has(shortcutAction) && (
          <span className="text-xs text-red-500">被其他软件占用，按了没反应</span>
        )}
        {isRecording ? (
          <span className="font-mono text-sm align-middle rounded-md pl-2 pr-1 py-1 transition-colors bg-gray-200 animate-pulse">
            请按下快捷键，Backspace 清除，Esc 取消
          </span>
        ) : (
          <ShortcutRenderer shortcut={shortcut.key} />
        )}
      </span>
    </div>
  ) : null
}

export function ResetDefaultShortcuts() {
  const { shortcuts, resetShortcuts } = useShortcutsStore()
  return (
    <Button
      variant="outline"
      size="sm"
      className="ml-auto"
      onClick={async () => {
        await window.api.updateShortcuts(
          Object.values(shortcuts)
            .filter(({ key, defaultKey }) => key !== defaultKey)
            .map((shortcut) => ({
              ...shortcut,
              key: shortcut.defaultKey
            }))
        )
        resetShortcuts()
        toast.success('重置默认快捷键成功')
      }}
    >
      重置默认快捷键
    </Button>
  )
}
