import { useEffect, useRef } from 'react'
import { stopListening } from '@/conversation/listening'
import { useSettingsStore } from '@/lib/store/settings'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useSolutionStore } from '@/lib/store/solution'
import { describeCaptureError, startAudioCapture, stopAudioCapture } from '@/lib/audio-capture'
import { useModePage } from '@/lib/use-mode-page'

import { AppHeader } from './AppHeader'
import { AppContent } from './AppContent'
import { AppStatusBar } from './AppStatusBar'
import { PrerequisitesChecker } from './PrerequisitesChecker'
import { SnipQuestionDialog } from './SnipQuestionDialog'
import { TranscriptionBar } from './TranscriptionBar'

export default function CoderPage() {
  const { dashscopeApiKey } = useSettingsStore()
  const { isTranscribing, setIsTranscribing, setTranscriptionText, clearText } =
    useTranscriptionStore()
  const { setErrorMessage } = useSolutionStore()
  const operation = useRef(0)
  const starting = useRef(false)

  useModePage('screenshot')

  // 对话模式 keeps listening while its user visits the settings; coming here
  // instead ends that conversation's recognition, whose sentences would
  // otherwise never reach this page's transcript. That stop drains for up to
  // 700ms, so the flag goes at once: a toggle meanwhile must start this page's
  // transcription (which waits for the drain), not stop the conversation again
  useEffect(() => {
    useTranscriptionStore.getState().setIsTranscribing(false)
    void stopListening()
  }, [])

  useEffect(() => {
    const handleToggle = async () => {
      const request = ++operation.current
      if (starting.current || useTranscriptionStore.getState().isTranscribing) {
        starting.current = false
        stopAudioCapture()
        await window.api.stopTranscription()
        if (request === operation.current) setIsTranscribing(false)
      } else {
        if (!dashscopeApiKey) {
          setErrorMessage('请先在设置中配置百炼平台 API Key')
          return
        }
        starting.current = true
        let phase: 'capture' | 'asr' = 'asr'
        try {
          // A conversation may still be draining after this page mounted.
          // Its stopped event must finish before a new capture graph exists.
          await stopListening()
          if (request !== operation.current) return
          phase = 'capture'
          await startAudioCapture()
          if (request !== operation.current) return
          phase = 'asr'
          await window.api.startTranscription(dashscopeApiKey)
          if (request !== operation.current) return
          setIsTranscribing(true)
          setErrorMessage(null)
        } catch (err) {
          if (request !== operation.current) return
          console.error('Failed to start transcription:', err)
          stopAudioCapture()
          setErrorMessage(
            phase === 'capture'
              ? describeCaptureError('启动录音失败', err)
              : err instanceof Error
                ? err.message
                : String(err)
          )
        } finally {
          if (request === operation.current) starting.current = false
        }
      }
    }

    window.api.onToggleTranscription(handleToggle)
    return () => {
      window.api.removeToggleTranscriptionListener()
    }
  }, [isTranscribing, dashscopeApiKey, setIsTranscribing, setErrorMessage])

  useEffect(() => {
    window.api.onTranscriptionText((data) => {
      setTranscriptionText(data.text)
    })
    window.api.onTranscriptionError((message) => {
      setErrorMessage(message)
      setIsTranscribing(false)
      stopAudioCapture()
    })
    window.api.onTranscriptionCleared(() => {
      clearText()
    })

    return () => {
      window.api.removeTranscriptionTextListener()
      window.api.removeTranscriptionErrorListener()
      window.api.removeTranscriptionClearedListener()
    }
  }, [setTranscriptionText, setErrorMessage, setIsTranscribing, clearText])

  useEffect(() => {
    const lifecycle = operation
    return () => {
      lifecycle.current++
      if (starting.current || useTranscriptionStore.getState().isTranscribing) {
        starting.current = false
        stopAudioCapture()
        window.api.stopTranscription()
      }
    }
  }, [])

  return (
    <div className="relative h-screen">
      <AppHeader mode="screenshot" />
      <AppContent />
      <TranscriptionBar />
      <AppStatusBar />
      <SnipQuestionDialog />
      <PrerequisitesChecker />
    </div>
  )
}
