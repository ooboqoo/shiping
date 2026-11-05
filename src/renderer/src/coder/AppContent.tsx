import { Fragment, useCallback, useEffect, useMemo, useRef } from 'react'
import { Brain, ChevronDown, Images } from 'lucide-react'
import { useSettingsStore, type ScreenshotDisplay } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useSolutionStore, type ReasoningRound, type RoundUi } from '@/lib/store/solution'
import { cn } from '@/lib/utils'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import ShortcutRenderer from '@/components/ShortcutRenderer'

const SCROLL_OFFSET = 120

export function AppContent() {
  const {
    screenshotData,
    recentScreenshots,
    screenshotTotal,
    solutionChunks,
    reasoningRounds,
    liveRound,
    roundUi,
    errorMessage,
    setScreenshotData,
    setRecentScreenshots,
    setIsLoading,
    addSolutionChunk,
    addReasoningChunk,
    startReasoningRound,
    setLiveRound,
    setRoundOpen,
    setErrorMessage,
    clearSolution
  } = useSolutionStore()

  const screenshotDisplay = useSettingsStore((state) => state.screenshotDisplay)

  // Each chunk arrives as its own IPC message, and writing it straight to the
  // store re-renders and re-parses the whole markdown answer once per chunk. A
  // fast model outruns that as the answer grows, and the text lags further and
  // further behind the stream. Buffering until the next animation frame caps the
  // work at one parse per frame, however fast the chunks come. Reasoning chunks
  // get their own buffer but share the frame.
  const pendingChunks = useRef<string[]>([])
  const pendingReasoning = useRef<string[]>([])
  const frameHandle = useRef<number | null>(null)

  const flushChunks = useCallback(() => {
    if (frameHandle.current !== null) {
      window.cancelAnimationFrame(frameHandle.current)
      frameHandle.current = null
    }
    if (pendingChunks.current.length > 0) {
      addSolutionChunk(pendingChunks.current.join(''))
      pendingChunks.current = []
    }
    if (pendingReasoning.current.length > 0) {
      addReasoningChunk(pendingReasoning.current.join(''))
      pendingReasoning.current = []
    }
  }, [addSolutionChunk, addReasoningChunk])

  const discardPendingChunks = useCallback(() => {
    if (frameHandle.current !== null) {
      window.cancelAnimationFrame(frameHandle.current)
      frameHandle.current = null
    }
    pendingChunks.current = []
    pendingReasoning.current = []
  }, [])

  useEffect(() => {
    // Listen for screenshot events (latest)
    window.api.onScreenshotTaken((data: string) => {
      setScreenshotData(data)
    })

    // Listen for screenshots-updated events (gallery)
    window.api.onScreenshotsUpdated((screenshots: string[], total: number) => {
      setRecentScreenshots(screenshots, total)
    })

    // New session clear (pictures + answers)
    window.api.onSolutionClear(() => {
      // Chunks still buffered belong to the answer being cleared
      discardPendingChunks()
      clearSolution()
    })

    // Listen for solution chunks, buffered until the next frame (see pendingChunks)
    window.api.onSolutionChunk((chunk: string) => {
      pendingChunks.current.push(chunk)
      if (frameHandle.current === null) {
        frameHandle.current = window.requestAnimationFrame(flushChunks)
      }
    })

    // What a thinking model reasoned before answering, buffered the same way;
    // it lands in the last round, which `addReasoningChunk` marks as live
    window.api.onReasoningChunk((chunk: string) => {
      pendingReasoning.current.push(chunk)
      if (frameHandle.current === null) {
        frameHandle.current = window.requestAnimationFrame(flushChunks)
      }
    })

    // An appended screenshot or follow-up gets its own round: land any
    // buffered chunks in the previous round first, then open one whose answer
    // text starts at the current end of the text (just after the `---`)
    window.api.onReasoningRoundStart(() => {
      flushChunks()
      const store = useSolutionStore.getState()
      startReasoningRound(store.solutionChunks.join('').length)
    })

    // AI loading
    window.api.onAiLoadingStart(() => {
      setIsLoading(true)
      setErrorMessage(null) // Clear error when new request starts
    })
    window.api.onAiLoadingEnd(() => {
      setIsLoading(false)
    })

    // Cleanup listeners on unmount
    return () => {
      discardPendingChunks()
      window.api.removeScreenshotListener()
      window.api.removeScreenshotsUpdatedListener()
      window.api.removeSolutionChunkListener()
      window.api.removeReasoningChunkListener()
      window.api.removeReasoningRoundStartListener()
      window.api.removeAiLoadingStartListener()
      window.api.removeAiLoadingEndListener()
      window.api.removeSolutionClearListener()
    }
  }, [
    setScreenshotData,
    setRecentScreenshots,
    clearSolution,
    setIsLoading,
    flushChunks,
    discardPendingChunks,
    startReasoningRound,
    setErrorMessage
  ])

  useEffect(() => {
    // Flush at once when the stream ends rather than waiting for a frame: a
    // hidden window may not paint one for a while, and the answer must be
    // complete in the store the moment it is reported finished
    window.api.onSolutionComplete(() => {
      flushChunks()
      setIsLoading(false)
      setLiveRound(null)
    })
    window.api.onSolutionStopped(() => {
      flushChunks()
      setIsLoading(false)
      setLiveRound(null)
    })
    window.api.onSolutionError((message: string) => {
      flushChunks()
      setIsLoading(false)
      setLiveRound(null)
      setErrorMessage(message)
    })
    return () => {
      window.api.removeSolutionCompleteListener()
      window.api.removeSolutionStoppedListener()
      window.api.removeSolutionErrorListener()
    }
  }, [flushChunks, setIsLoading, setLiveRound, setErrorMessage])

  useEffect(() => {
    window.api.onScrollPageUp(() => {
      const container = document.getElementById('app-content')
      if (!container) return
      container.scrollTo({
        top: container.scrollTop - window.innerHeight + SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    return () => {
      window.api.removeScrollPageUpListener()
    }
  }, [])

  useEffect(() => {
    window.api.onScrollPageDown(() => {
      const container = document.getElementById('app-content')
      if (!container) return
      container.scrollTo({
        top: container.scrollTop + window.innerHeight - SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    return () => {
      window.api.removeScrollPageDownListener()
    }
  }, [])

  // `screenshots-updated` always accompanies `screenshot-taken`; the fallback only
  // covers a render that lands between the two
  const screenshots =
    recentScreenshots.length > 0 ? recentScreenshots : screenshotData ? [screenshotData] : []

  // Stable between chunks, so the memoized renderer skips the renders caused by
  // the rest of the solution store (loading flag, timing, errors)
  const solutionText = useMemo(() => solutionChunks.join(''), [solutionChunks])

  // One answer segment per round, cut at the snapshots taken when each round
  // began — right after main sent that round's `---` separator, so the
  // separator stays at the end of the previous segment and the cut is at a
  // paragraph boundary
  const answerSegments = useMemo(
    () =>
      reasoningRounds.map((round, index) =>
        solutionText.slice(round.textStart, reasoningRounds[index + 1]?.textStart)
      ),
    [solutionText, reasoningRounds]
  )

  return (
    // The status bar (32px) floats over the bottom: the end of the answer must clear it
    <div id="app-content" className="px-6 pt-4 pb-12">
      {/* Error Banner */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-red-400 font-medium text-sm">API 调用失败</p>
            <p className="text-red-300/80 text-sm mt-0.5 break-words">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-400/80 hover:text-red-300 flex-shrink-0"
            title="关闭"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Screenshots, rendered as the `screenshotDisplay` setting asks */}
      {screenshots.length === 0 ? (
        <ShortcutTip />
      ) : (
        <Screenshots
          screenshots={screenshots}
          total={Math.max(screenshotTotal, screenshots.length)}
          display={screenshotDisplay}
        />
      )}

      {/* Answers interleave with their reasoning: 思考1 正文1 --- 思考2 正文2.
          Each round's block sits above that round's answer segment; a round
          without reasoning shows no block but still owns its segment. The
          branch below only covers text that arrived with no rounds at all
          (a conversation always has round 0 from the moment it is cleared). */}
      {reasoningRounds.length === 0 ? (
        <MarkdownRenderer>{solutionText}</MarkdownRenderer>
      ) : (
        reasoningRounds.map((round, index) => (
          <Fragment key={index}>
            <ReasoningBlock
              round={round}
              label={index === 0 ? '思考过程' : `思考过程 · ${index + 1}`}
              live={liveRound === index}
              answerStarted={solutionText.length > round.textStart}
              ui={roundUi[index]}
              onToggle={(open) => setRoundOpen(index, !open)}
            />
            <MarkdownRenderer>{answerSegments[index] ?? ''}</MarkdownRenderer>
          </Fragment>
        ))
      )}
    </div>
  )
}

/**
 * One request round's reasoning, streamed above that round's answer. While the
 * model is reasoning the box holds a fixed three lines, the latest pushing up
 * from the bottom, so the stream never moves the layout around. Once the
 * answer starts the block folds to its header line; it reopens on a click,
 * and a click also stops it from following the stream again.
 */
function ReasoningBlock({
  round,
  label,
  live,
  answerStarted,
  ui,
  onToggle
}: {
  round: ReasoningRound
  label: string
  /** Chunks are still arriving for this round */
  live: boolean
  /** This round's answer text has started below it */
  answerStarted: boolean
  /** What the user chose for this round; absent until they click its header */
  ui: RoundUi | undefined
  /** Called with the state the block is currently in, so a click always flips it */
  onToggle: (open: boolean) => void
}) {
  const reasoningText = useMemo(() => round.chunks.join(''), [round.chunks])
  if (!reasoningText) return null

  const open = ui?.pinned ? ui.open : live && !answerStarted
  const streaming = open && live && !answerStarted

  return (
    <div className="mb-4 rounded-lg border border-app-border">
      <button
        type="button"
        onClick={() => onToggle(open)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs text-app-muted-fg select-none"
      >
        <Brain className="size-3.5" />
        <span>{label}</span>
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          className={cn(
            'px-3 pb-2 text-xs break-words opacity-80',
            // Fixed height while reasoning streams: three lines plus the bottom
            // padding, so no line is cut in half. A bounded scroll once done
            streaming
              ? 'flex h-[calc(3lh+0.5rem)] flex-col justify-end overflow-hidden'
              : 'max-h-64 overflow-y-auto'
          )}
        >
          <MarkdownRenderer compact>{reasoningText}</MarkdownRenderer>
        </div>
      )}
    </div>
  )
}

function Screenshots({
  screenshots,
  total,
  display
}: {
  screenshots: string[]
  /** Every screenshot sent to the AI, which can exceed the thumbnails kept around */
  total: number
  display: ScreenshotDisplay
}) {
  if (display === 'none') return null

  if (display === 'count') {
    // Themed so the card reads correctly on both the dark and the light surface
    return (
      <div className="mb-4 inline-flex items-center gap-1.5 rounded-lg border border-app-chip-border bg-app-chip px-2.5 py-1 text-sm text-app-chip-fg select-none">
        <Images className="h-4 w-4" />
        {total} 张截图
      </div>
    )
  }

  return (
    <div className="mb-4 flex gap-2 overflow-x-auto pb-2">
      {screenshots.map((data, index) => (
        <img
          key={index}
          src={`data:image/png;base64,${data}`}
          alt={`Screenshot ${index + 1}`}
          className="w-40 h-auto flex-shrink-0 border border-app-border rounded-lg shadow-lg hover:shadow-xl transition-shadow"
          title={`第 ${index + 1} 张截图`}
        />
      ))}
    </div>
  )
}

function ShortcutTip() {
  const { shortcuts } = useShortcutsStore()
  return (
    <div className="flex items-center justify-center h-full text-xl text-app-muted-fg select-none">
      请按下快捷键
      <ShortcutRenderer
        shortcut={shortcuts.takeScreenshot.key}
        className="mx-1 font-bold text-black"
      />
      抓取屏幕进行分析
    </div>
  )
}
