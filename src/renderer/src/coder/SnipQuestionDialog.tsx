import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

type SnipQuestion = NonNullable<Parameters<Parameters<Window['api']['onSnipQuestion']>[0]>[0]>

/**
 * The question box of a 框选 screenshot held back for a question (「框选后」 or Shift): the
 * screenshot, what to ask about it, Enter to send. Main holds the screenshot
 * and closes this (null) once anything replaces it. Until it is sent the
 * conversation behind is untouched, so closing it changes nothing; Esc also
 * hides the window, as anywhere after 框选识别, handing the keyboard back
 */
export function SnipQuestionDialog() {
  // Kept while closing, so the screenshot does not vanish mid-animation
  const [pending, setPending] = useState<SnipQuestion | null>(null)
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')

  useEffect(() => {
    window.api.onSnipQuestion((next) => {
      if (!next) {
        setOpen(false)
        return
      }
      setPending(next)
      setQuestion('')
      setOpen(true)
    })
    return () => window.api.removeSnipQuestionListener()
  }, [])

  const send = () => {
    setOpen(false)
    void window.api.sendSnipQuestion(question)
  }

  const cancel = (hide: boolean) => {
    setOpen(false)
    void window.api.cancelSnipQuestion()
    if (hide) void window.api.hideMainWindow()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && cancel(false)}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto"
        onEscapeKeyDown={(e) => {
          // Handled here either way, so the page's own Esc does not hide the window too
          e.preventDefault()
          // Esc while composing only cancels the input method's candidate
          if (!e.isComposing) cancel(true)
        }}
        // A stray click outside must not throw the screenshot away
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle>{pending?.append ? '追加截图并提问' : '针对截图提问'}</DialogTitle>
        {pending && (
          <img
            src={`data:image/png;base64,${pending.image}`}
            alt="框选的截图"
            className="mx-auto max-h-[35vh] w-auto max-w-full rounded-md border border-app-border object-contain"
          />
        )}
        <Textarea
          placeholder="想问什么？Enter 发送，Shift+Enter 换行；不填直接发送"
          value={question}
          className="min-h-20"
          onChange={(e) => setQuestion(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => cancel(false)}>
            取消
          </Button>
          <Button onClick={send}>{question.trim() ? '发送' : '直接发送'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
