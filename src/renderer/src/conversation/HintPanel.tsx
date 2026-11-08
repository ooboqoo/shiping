import { useEffect, useRef, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Brain, Eraser, LoaderCircle, PanelLeftOpen, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useSettingsStore } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useConversationStore } from '@/lib/store/conversation'
import { hasAnswerText, NO_REPLY, type HintCard } from '../../../shared/conversation'
import { startListening } from './listening'
import { observeHintVisible } from './hint-visibility'

/** What one page of scrolling keeps of the previous page, so the eye finds its place */
const PAGE_OVERLAP = 120

export function HintPanel() {
  const hints = useConversationStore((state) => state.hints)
  const errorMessage = useConversationStore((state) => state.errorMessage)
  const setErrorMessage = useConversationStore((state) => state.setErrorMessage)
  const transcriptHidden = useSettingsStore((state) => state.conversationTranscriptHidden)
  const updateSetting = useSettingsStore((state) => state.updateSetting)
  const panelRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<number, HTMLElement>())
  // Zero on mount, so coming back to the page (from the settings, say) lands on the newest hint
  const lastCount = useRef(0)
  const lastStatuses = useRef(new Map<number, HintCard['status']>())

  // A new hint scrolls to the top of the panel; the stream then fills it in
  // without dragging the view along, so reading from the top is not disturbed.
  // One that ends up longer than the panel pages down once when it is done,
  // so reading on needs no scrolling by hand - a mouse or a key press is easy
  // to spot on a call
  useEffect(() => {
    const previous = lastStatuses.current
    lastStatuses.current = new Map(hints.map((card) => [card.id, card.status]))
    const panel = panelRef.current
    if (!panel) return

    if (hints.length > lastCount.current) {
      cardRefs.current.get(hints[hints.length - 1].id)?.scrollIntoView({
        block: 'start',
        // On mount: straight there, not a ride through the history
        behavior: lastCount.current === 0 ? 'instant' : 'smooth'
      })
    } else {
      for (const card of hints) {
        const el = cardRefs.current.get(card.id)
        if (el && card.status === 'done' && previous.get(card.id) === 'streaming') {
          revealRest(panel, el)
        }
      }
    }
    lastCount.current = hints.length
  }, [hints])

  useEffect(() => {
    const scroll = (direction: 1 | -1) => () => {
      const panel = panelRef.current
      if (!panel) return
      panel.scrollTo({
        top: panel.scrollTop + direction * pageStep(panel),
        behavior: 'smooth'
      })
    }
    window.api.onScrollPageUp(scroll(-1))
    window.api.onScrollPageDown(scroll(1))
    return () => {
      window.api.removeScrollPageUpListener()
      window.api.removeScrollPageDownListener()
    }
  }, [])

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-app-muted-fg select-none">
        {transcriptHidden && (
          <button
            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--app-hover-bg)] cursor-pointer"
            onClick={() => updateSetting('conversationTranscriptHidden', false)}
          >
            <PanelLeftOpen className="size-3.5" />
            展开对话
          </button>
        )}
        <span className="font-medium">提示</span>
        {hints.length > 0 && (
          <button
            className="ml-auto flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--app-hover-bg)] cursor-pointer"
            onClick={() => void window.api.clearConversation()}
          >
            <Eraser className="size-3.5" />
            清空对话
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-red-500/50 bg-red-500/20 p-2 text-sm text-red-300">
          <span className="min-w-0 flex-1 break-words">{errorMessage}</span>
          <button
            className="shrink-0 text-red-400/80 hover:text-red-300 cursor-pointer"
            aria-label="关闭"
            onClick={() => setErrorMessage(null)}
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div
        ref={panelRef}
        className="panel-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-4"
      >
        {hints.length === 0 ? (
          <EmptyState />
        ) : (
          hints.map((card) => (
            // The newest card keeps a full panel of room under it, else a short
            // one could not scroll to the top: it would stop at the bottom edge
            // with only its first line showing, and grow out of sight from there
            <div key={card.id} className="last:min-h-full">
              <HintCardView
                card={card}
                ref={(el) => {
                  if (el) cardRefs.current.set(card.id, el)
                  else cardRefs.current.delete(card.id)
                }}
              />
            </div>
          ))
        )}
      </div>
    </section>
  )
}

/** How far the panel scrolls for one page, by the shortcut or after a long hint */
function pageStep(panel: HTMLElement): number {
  return Math.max(panel.clientHeight - PAGE_OVERLAP, panel.clientHeight / 2)
}

/**
 * A finished hint that runs past the bottom of the panel: scroll down to its
 * end, one page at most. Only while it still sits at the top where it was
 * brought into view; anyone who scrolled since is reading somewhere else.
 */
function revealRest(panel: HTMLElement, card: HTMLElement) {
  const view = panel.getBoundingClientRect()
  const box = card.getBoundingClientRect()
  const top = box.top - view.top
  const hidden = box.bottom - view.bottom
  // The card's scroll-mt-2 puts it 8px down, plus some slack for rounding
  if (hidden <= 0 || top < -1 || top > 16) return
  panel.scrollBy({
    // The panel's pb-4 below the card's end
    top: Math.min(hidden + 16, pageStep(panel)),
    behavior: 'smooth'
  })
}

function HintCardView({ card, ref }: { card: HintCard; ref: (el: HTMLElement | null) => void }) {
  const answerRef = useRef<HTMLDivElement | null>(null)
  const setFocusedHintId = useConversationStore((state) => state.setFocusedHintId)
  // What it answers, for when the transcript column is hidden or scrolled away
  const question = useConversationStore((state) =>
    state.utterances
      .filter((u) => u.id >= card.fromId && u.id <= card.toId)
      .map((u) => u.text)
      .join(' ')
  )
  const noReply = card.status === 'done' && card.text.trim() === NO_REPLY
  const hasText = hasAnswerText(card.text)
  const { id, requestedAt, requestId, firstTextAt, visibleLatencyMs, status } = card
  useEffect(() => {
    const element = answerRef.current
    if (
      !element ||
      !hasText ||
      status === 'waiting' ||
      requestedAt === undefined ||
      requestId === undefined ||
      firstTextAt === undefined ||
      visibleLatencyMs !== undefined
    )
      return
    return observeHintVisible(element, () => {
      return window.api.reportHintVisible(id, requestedAt, requestId).catch(() => false)
    })
  }, [id, requestId, requestedAt, firstTextAt, visibleLatencyMs, status, hasText])

  return (
    <article
      ref={ref}
      className={cn(
        'scroll-mt-2 rounded-lg border border-app-border px-3 py-2',
        noReply && 'opacity-50'
      )}
      onMouseEnter={() => setFocusedHintId(card.id)}
      onMouseLeave={() => setFocusedHintId(null)}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] text-app-muted-fg select-none">
        {question && <span className="min-w-0 truncate">「{question}」</span>}
        <span className="ml-auto shrink-0">
          {card.source === 'auto' ? '自动' : '手动'}
          {card.status === 'stopped' && ' · 已停止'}
        </span>
      </div>
      {card.latencyMs !== undefined && (
        <p className="mb-1 flex flex-wrap gap-x-2 text-[11px] text-app-muted-fg select-none">
          <span>首字 {(card.latencyMs / 1000).toFixed(1)}s</span>
          {card.speechLatencyMs !== undefined && (
            <span>语音 {(card.speechLatencyMs / 1000).toFixed(1)}s</span>
          )}
          {card.visibleLatencyMs !== undefined && (
            <span>上屏 {(card.visibleLatencyMs / 1000).toFixed(1)}s</span>
          )}
        </p>
      )}
      {card.status === 'waiting' ? (
        <p className="animate-pulse text-sm text-app-muted-fg">对方还在说，说完后重新生成…</p>
      ) : card.status === 'streaming' && !card.text ? (
        <p className="flex items-center gap-1.5 text-sm text-app-muted-fg">
          <LoaderCircle className="size-3.5 animate-spin" />
          正在生成…
        </p>
      ) : null}
      {card.reasoning && card.status !== 'waiting' && (
        <details className="mb-1 text-xs text-app-muted-fg">
          <summary className="flex cursor-pointer items-center gap-1 select-none">
            <Brain className="size-3" />
            思考过程
          </summary>
          <div className="mt-1 max-h-32 overflow-y-auto break-words opacity-80">
            <MarkdownRenderer compact>{card.reasoning}</MarkdownRenderer>
          </div>
        </details>
      )}
      {card.text && card.status !== 'waiting' && (
        <div ref={answerRef}>
          <MarkdownRenderer>{card.text}</MarkdownRenderer>
        </div>
      )}
      {card.status === 'error' && (
        <p className="text-sm break-words text-red-400">生成失败：{card.error}</p>
      )}
    </article>
  )
}

function EmptyState() {
  const navigate = useNavigate()
  const { shortcuts } = useShortcutsStore()
  const dashscopeApiKey = useSettingsStore((state) => state.dashscopeApiKey)
  const hintMode = useSettingsStore((state) => state.conversationHintMode)
  const isTranscribing = useTranscriptionStore((state) => state.isTranscribing)
  const hasUtterances = useConversationStore((state) => state.utterances.length > 0)
  const key = (action: string) => (
    <ShortcutRenderer
      shortcut={shortcuts[action].key}
      className="mx-1 inline-block border border-current bg-transparent px-1 py-0 text-xs"
    />
  )

  let content: ReactNode
  if (!dashscopeApiKey) {
    content = (
      <>
        <p>对话模式靠语音识别听对方说话，需要先填写百炼平台 API Key</p>
        <Button size="sm" variant="secondary" onClick={() => navigate('/settings?tab=voice')}>
          去设置
        </Button>
      </>
    )
  } else if (!isTranscribing && !hasUtterances) {
    content = (
      <>
        <p>按{key('toggleTranscription')}开始监听对方说话</p>
        <Button size="sm" variant="secondary" onClick={() => void startListening()}>
          开始监听
        </Button>
      </>
    )
  } else if (hintMode === 'auto') {
    content = <p>对方说完一句话，这里就会出提示；也可以按{key('generateHint')}立即出</p>
  } else {
    content = <p>手动模式：按{key('generateHint')}出提示</p>
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-app-muted-fg select-none">
      {content}
    </div>
  )
}
