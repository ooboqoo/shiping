import { useEffect, useState } from 'react'
import { Pointer, PointerOff, OctagonX, MessageCircle } from 'lucide-react'
import { useSolutionStore } from '@/lib/store/solution'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useAppStore } from '@/lib/store/app'
import { useSettingsStore } from '@/lib/store/settings'
import { formatDuration } from '@/lib/utils/duration'
import { useElapsed } from '@/lib/use-elapsed'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { Button } from '@/components/ui/button'
import { Dialog, DialogTitle, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

/** Whether the window is up for 框选识别's answer and holds the keyboard; main says when it ends */
function useSnipSession(): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    window.api.onSnipSession(setActive)
    return () => window.api.removeSnipSessionListener()
  }, [])
  return active
}

export function AppStatusBar() {
  const {
    isLoading: isReceivingSolution,
    setIsLoading,
    screenshotData,
    solutionChunks,
    setDurationMs
  } = useSolutionStore()
  const { ignoreMouse } = useAppStore()
  const { shortcuts } = useShortcutsStore()
  const hideShortcutHints = useSettingsStore((state) => state.hideShortcutHints)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [questionInput, setQuestionInput] = useState('')
  const elapsed = useElapsed()
  const snipSession = useSnipSession()
  const hasActiveConversation = screenshotData && solutionChunks.length > 0
  // Esc 隐藏窗口 is a hint after 新开对话, and Esc works exactly while it is shown: not
  // while the answer streams, nor with the hints hidden, nor with the follow-up
  // dialog open (Esc closes that instead)
  const canDismiss =
    snipSession && !!hasActiveConversation && !isReceivingSolution && !hideShortcutHints

  useEffect(() => {
    if (!canDismiss || isDialogOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      e.preventDefault()
      void window.api.hideMainWindow()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canDismiss, isDialogOpen])

  useEffect(() => {
    // Main measures the request and reports once, so nothing ticks here
    window.api.onSolutionDuration((ms) => setDurationMs(ms))
    return () => {
      window.api.removeSolutionDurationListener()
    }
  }, [setDurationMs])

  const handleStop = () => {
    setIsLoading(false)
    void window.api.stopSolutionStream()
  }

  const handleFollowUpClick = () => {
    setIsDialogOpen(true)
  }

  const handleDialogClose = () => {
    setIsDialogOpen(false)
    setQuestionInput('')
  }

  const handleSubmitQuestion = async () => {
    if (!questionInput.trim()) return

    setIsLoading(true)
    setIsDialogOpen(false)
    const question = questionInput.trim()
    setQuestionInput('')

    try {
      const result = await window.api.sendFollowUpQuestion(question)
      // Rejected before streaming (e.g. no API key), so no event will end the spinner
      if (!result?.success) setIsLoading(false)
    } catch (error) {
      console.error('Error sending follow-up question:', error)
      setIsLoading(false)
    }
  }

  return (
    <div className="absolute bottom-0 flex items-center justify-between w-full text-app-status-fg bg-app-status px-4 pb-1">
      <div>
        {isReceivingSolution ? (
          <div className="flex items-center space-x-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-r-2 border-[currentColor]"></div>
            <span className="text-sm">正在生成...</span>
            {elapsed !== null && (
              <span className="text-sm tabular-nums opacity-70">{formatDuration(elapsed)}</span>
            )}
            <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex justify-center z-50 pointer-events-none">
              <Button
                variant="secondary"
                className="h-8 px-4 text-base shadow-lg pointer-events-auto"
                onClick={handleStop}
              >
                <OctagonX className="w-4 h-4" />
                停止生成
                <ShortcutRenderer
                  shortcut={shortcuts.stopSolutionStream.key}
                  className="inline-block border bg-transparent py-0 px-1"
                />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center space-x-2 pointer-events-none opacity-50 text-sm gap-1">
            {/* Next to 正在生成 the number reads as elapsed time; on its own it needs a label */}
            {elapsed !== null && (
              <span className="tabular-nums">用时 {formatDuration(elapsed)}</span>
            )}
            {hasActiveConversation && !hideShortcutHints && (
              <>
                <span>
                  <ShortcutRenderer
                    shortcut={shortcuts.appendScreenshot.key}
                    className="inline-block scale-75 text-xs border border-current bg-transparent py-0 px-1 ml-1"
                  />
                  追加截图
                </span>
                <span>
                  <ShortcutRenderer
                    shortcut={shortcuts.takeScreenshot.key}
                    className="inline-block scale-75 text-xs border border-current bg-transparent py-0 px-1"
                  />
                  新开对话
                </span>
                {canDismiss && (
                  <span>
                    <ShortcutRenderer
                      shortcut="Esc"
                      className="inline-block scale-75 text-xs border border-current bg-transparent py-0 px-1"
                    />
                    隐藏窗口
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center space-x-4 select-none">
        {/* Follow-up Question Button */}
        {hasActiveConversation && !isReceivingSolution && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleFollowUpClick}
            className="h-7 px-3 text-xs"
            disabled={isReceivingSolution}
          >
            <MessageCircle className="w-4 h-4 mr-1" />
            追问问题
          </Button>
        )}
        {/* Mouse Status Indicator */}
        <div className="flex items-center">
          {ignoreMouse ? (
            <>
              <PointerOff className="w-4 h-4 mr-2" />
              <span className="text-xs">
                取消鼠标透传
                <ShortcutRenderer
                  shortcut={shortcuts.ignoreOrEnableMouse.key}
                  className="inline-block scale-75 text-xs border border-current bg-transparent py-0 px-1"
                />
              </span>
            </>
          ) : (
            <Pointer className="w-4 h-4" />
          )}
        </div>
      </div>

      {/* Follow-up Question Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogTitle className="sr-only">追问问题</DialogTitle>
        <DialogContent>
          <div className="py-4">
            <Textarea
              placeholder="请输入追问内容，按 Ctrl+Enter 提交..."
              value={questionInput}
              className="min-h-24"
              onChange={(e) => setQuestionInput(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSubmitQuestion()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleDialogClose}>
              取消
            </Button>
            <Button onClick={handleSubmitQuestion} disabled={!questionInput.trim()}>
              提交
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
