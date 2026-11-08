import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useSettingsStore } from '@/lib/store/settings'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useConversationStore } from '@/lib/store/conversation'
import { stopAudioCapture } from '@/lib/audio-capture'
import { useModePage } from '@/lib/use-mode-page'
import { AppHeader } from '@/coder/AppHeader'
import { PrerequisitesChecker } from '@/coder/PrerequisitesChecker'
import { TranscriptPanel } from './TranscriptPanel'
import { HintPanel } from './HintPanel'
import { ConversationStatusBar } from './ConversationStatusBar'
import { toggleHintMode, toggleListening } from './listening'
import { hasAnswerText } from '../../../shared/conversation'

/**
 * 对话模式: what the other side says on the left, the hints for it on the right.
 * The conversation itself lives in main (see main conversation.ts); this page
 * shows a copy of it.
 */
export default function ConversationPage() {
  const transcriptHidden = useSettingsStore((state) => state.conversationTranscriptHidden)

  useModePage('conversation')
  useConversationEvents()

  return (
    <div className="conversation-page flex h-screen flex-col">
      <AppHeader mode="conversation" />
      <div className="flex min-h-0 flex-1 max-[560px]:flex-col">
        {!transcriptHidden && <TranscriptPanel />}
        <HintPanel />
      </div>
      <ConversationStatusBar />
      <PrerequisitesChecker />
    </div>
  )
}

function useConversationEvents() {
  // Chunks come one IPC message each; writing them to the store once per frame
  // keeps a fast model from re-rendering the hint's markdown per chunk
  const pendingChunks = useRef(new Map<number, string>())
  const frameHandle = useRef<number | null>(null)

  useEffect(() => {
    const store = useConversationStore.getState()
    const flush = () => {
      frameHandle.current = null
      if (pendingChunks.current.size === 0) return
      useConversationStore.getState().appendHintText(pendingChunks.current)
      pendingChunks.current = new Map()
    }

    // Main may have moved on while this page was away (the settings, say)
    window.api.getConversationSnapshot().then((snapshot) => {
      store.applySnapshot(snapshot)
      const transcription = useTranscriptionStore.getState()
      // Recognition ended while no page was here to hear about it
      if (transcription.isTranscribing && !snapshot.listening) {
        stopAudioCapture()
        transcription.setIsTranscribing(false)
      }
    })

    window.api.onConversationUtterance((utterance) => store.upsertUtterance(utterance))
    window.api.onConversationUtteranceRemoved((id) => store.removeUtterance(id))
    window.api.onConversationHint((card) => {
      // Main's copy already holds every chunk sent before it
      pendingChunks.current.delete(card.id)
      store.upsertHint(card)
    })
    window.api.onConversationHintChunk((id, chunk) => {
      const card = useConversationStore.getState().hints.find((hint) => hint.id === id)
      if (!card || card.status !== 'streaming') return
      pendingChunks.current.set(id, (pendingChunks.current.get(id) ?? '') + chunk)
      if (!hasAnswerText(card.text) && hasAnswerText(pendingChunks.current.get(id)!)) {
        // The opening answer should reach React without waiting for another
        // animation frame; later deltas still share the normal frame batch.
        useConversationStore
          .getState()
          .appendHintText(new Map([[id, pendingChunks.current.get(id)!]]))
        pendingChunks.current.delete(id)
        return
      }
      if (frameHandle.current === null) {
        frameHandle.current = window.requestAnimationFrame(flush)
      }
    })
    window.api.onConversationCleared(() => {
      pendingChunks.current.clear()
      store.clear()
    })
    window.api.onConversationNotice((message) => toast(message, { duration: 2500 }))
    window.api.onToggleHintMode(toggleHintMode)

    return () => {
      if (frameHandle.current !== null) window.cancelAnimationFrame(frameHandle.current)
      frameHandle.current = null
      pendingChunks.current.clear()
      window.api.removeConversationListeners()
    }
  }, [])

  useEffect(() => {
    const transcription = useTranscriptionStore.getState()
    window.api.onToggleTranscription(toggleListening)
    window.api.onTranscriptionError((message) => {
      useConversationStore.getState().setErrorMessage(message)
      stopAudioCapture()
      transcription.setIsTranscribing(false)
    })
    window.api.onTranscriptionStopped(() => {
      stopAudioCapture()
      transcription.setIsTranscribing(false)
    })
    return () => {
      window.api.removeToggleTranscriptionListener()
      window.api.removeTranscriptionErrorListener()
      window.api.removeTranscriptionStoppedListener()
    }
  }, [])
}
