import { useEffect, useRef } from 'react'
import { Mic, PanelLeftClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollPanel } from '@/components/ScrollPanel'
import { useSettingsStore } from '@/lib/store/settings'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useConversationStore } from '@/lib/store/conversation'

/** How close to the bottom still counts as following the conversation */
const STICK_THRESHOLD = 40

/** The other side's sentences; the ones a hovered hint answers are highlighted */
export function TranscriptPanel() {
  const utterances = useConversationStore((state) => state.utterances)
  const focused = useConversationStore((state) =>
    state.hints.find((h) => h.id === state.focusedHintId)
  )
  const isTranscribing = useTranscriptionStore((state) => state.isTranscribing)
  const updateSetting = useSettingsStore((state) => state.updateSetting)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow new sentences, unless the user scrolled up to reread something
  const sticky = useRef(true)
  const hasSelf = utterances.some((u) => u.source === 'microphone')

  useEffect(() => {
    const el = scrollRef.current
    if (el && sticky.current) el.scrollTop = el.scrollHeight
  }, [utterances])

  return (
    <section className="flex w-2/5 min-w-0 shrink-0 flex-col border-r border-app-border max-[560px]:h-32 max-[560px]:w-full max-[560px]:border-r-0 max-[560px]:border-b">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-app-muted-fg select-none">
        <span className="font-medium">{hasSelf ? '对话原文' : '对方说的话'}</span>
        {isTranscribing && (
          <span className="flex items-center gap-1">
            <Mic className="size-3.5" />
            正在听
          </span>
        )}
        <button
          className="ml-auto flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--app-hover-bg)] cursor-pointer"
          onClick={() => updateSetting('conversationTranscriptHidden', true)}
        >
          <PanelLeftClose className="size-3.5" />
          收起
        </button>
      </div>
      <ScrollPanel
        viewportRef={scrollRef}
        className="min-h-0 flex-1"
        contentClassName="space-y-1.5 px-3 pb-3"
        onScroll={(e) => {
          const el = e.currentTarget
          sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
        }}
      >
        {utterances.length === 0 ? (
          <p className="pt-1 text-sm text-app-muted-fg">
            {isTranscribing ? '正在听对方说话…' : '开始监听后，对方说的话会逐句显示在这里'}
          </p>
        ) : (
          utterances.map((u) => (
            <p
              key={u.id}
              className={cn(
                'rounded-md bg-app-panel px-2 py-1 text-sm leading-relaxed text-app-panel-fg break-words transition-shadow',
                !u.final && 'opacity-60',
                focused &&
                  u.source !== 'microphone' &&
                  u.id >= focused.fromId &&
                  u.id <= focused.toId &&
                  'ring-2 ring-sky-400/70'
              )}
            >
              {hasSelf && (
                <span className="text-xs text-app-muted-fg">
                  {u.source === 'microphone' ? '我（实际回答）' : '对方'}：
                </span>
              )}
              {u.text}
            </p>
          ))
        )}
      </ScrollPanel>
    </section>
  )
}
