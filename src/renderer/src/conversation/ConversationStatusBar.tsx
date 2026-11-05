import { Lightbulb, Mic, MicOff, OctagonX, PointerOff } from 'lucide-react'
import { useNavigate } from 'react-router'
import { cn } from '@/lib/utils'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useAppStore } from '@/lib/store/app'
import { useSettingsStore, type HintMode } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useConversationStore } from '@/lib/store/conversation'
import { toggleHintMode, toggleListening } from './listening'

const HINT_MODES: { value: HintMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'manual', label: '手动' }
]

/** Listening, automatic / manual hints and the hint button, each with its shortcut */
export function ConversationStatusBar() {
  const navigate = useNavigate()
  const contextEnabled = useSettingsStore((state) => state.conversationContextEnabled)
  const contextRounds = useSettingsStore((state) => state.conversationContextRounds)
  const audioMode = useSettingsStore((state) => state.conversationAudioMode)
  const updateSetting = useSettingsStore((state) => state.updateSetting)
  const { ignoreMouse } = useAppStore()
  const { shortcuts } = useShortcutsStore()
  const hintMode = useSettingsStore((state) => state.conversationHintMode)
  const hideShortcutHints = useSettingsStore((state) => state.hideShortcutHints)
  const isTranscribing = useTranscriptionStore((state) => state.isTranscribing)
  const streaming = useConversationStore((state) =>
    state.hints.some((h) => h.status === 'streaming' || h.status === 'waiting')
  )

  const key = (action: string) =>
    !hideShortcutHints && (
      <ShortcutRenderer
        shortcut={shortcuts[action].key}
        className="inline-block scale-75 border border-current bg-transparent px-1 py-0 text-xs"
      />
    )

  return (
    <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 py-1 border-t border-app-border bg-app-status px-3 text-xs text-app-status-fg select-none">
      <button className="flex items-center gap-1 cursor-pointer" onClick={toggleListening}>
        {isTranscribing ? (
          <Mic className="size-3.5 animate-pulse text-green-500" />
        ) : (
          <MicOff className="size-3.5 opacity-70" />
        )}
        {isTranscribing ? '停止监听' : '开始监听'}
        {key('toggleTranscription')}
      </button>

      <div className="flex items-center gap-1">
        <div className="flex items-center rounded-md bg-app-chip p-0.5">
          {HINT_MODES.map(({ value, label }) => (
            <button
              key={value}
              className={cn(
                'rounded px-1.5 py-0.5',
                value === hintMode
                  ? 'bg-[var(--app-hover-bg)]'
                  : 'opacity-60 hover:opacity-100 cursor-pointer'
              )}
              onClick={() => value !== hintMode && toggleHintMode()}
            >
              {label}
            </button>
          ))}
        </div>
        {key('toggleHintMode')}
      </div>

      {streaming ? (
        <button
          className="flex items-center gap-1 cursor-pointer"
          onClick={() => void window.api.stopHints()}
        >
          <OctagonX className="size-3.5" />
          停止
          {key('stopSolutionStream')}
        </button>
      ) : (
        <button
          className="flex items-center gap-1 cursor-pointer"
          onClick={() => void window.api.requestHint()}
        >
          <Lightbulb className="size-3.5" />
          出提示
          {key('generateHint')}
        </button>
      )}

      <button
        aria-label="切换摘要上下文"
        aria-pressed={contextEnabled}
        title="点击开关历史摘要，不清空对话记录"
        className="cursor-pointer"
        onClick={() => updateSetting('conversationContextEnabled', !contextEnabled)}
      >
        上下文 {contextEnabled ? `${contextRounds}轮摘要` : '关'}
      </button>
      <button
        title="设置轮数、预算与录音来源"
        className="cursor-pointer text-app-muted-fg"
        onClick={() => navigate('/settings?tab=conversation')}
      >
        {audioMode === 'dual' ? '电脑 + 麦克风' : audioMode === 'system' ? '仅电脑' : '仅麦克风'}
      </button>
      {ignoreMouse && (
        <span className="ml-auto flex items-center gap-1">
          <PointerOff className="size-3.5" />
          取消鼠标穿透
          {key('ignoreOrEnableMouse')}
        </span>
      )}
    </div>
  )
}
