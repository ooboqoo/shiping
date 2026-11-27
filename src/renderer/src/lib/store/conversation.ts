import { create } from 'zustand'
import type { ConversationSnapshot, HintCard, Utterance } from '../../../../shared/conversation'

/**
 * 对话模式's page state: a copy of what main holds (see main conversation.ts),
 * refreshed from a snapshot on mount and kept current by its events.
 */
interface ConversationState {
  utterances: Utterance[]
  hints: HintCard[]
  errorMessage: string | null
  /** The hint whose sentences are highlighted in the transcript */
  focusedHintId: number | null
}

interface ConversationStore extends ConversationState {
  applySnapshot: (snapshot: ConversationSnapshot) => void
  upsertUtterance: (utterance: Utterance) => void
  removeUtterance: (id: number) => void
  /** Main's copy of a card is complete: it replaces whatever chunks came before */
  upsertHint: (card: HintCard) => void
  removeHint: (id: number) => void
  appendHintText: (chunks: Map<number, string>) => void
  clear: () => void
  setErrorMessage: (message: string | null) => void
  setFocusedHintId: (id: number | null) => void
}

export const useConversationStore = create<ConversationStore>()((set) => ({
  utterances: [],
  hints: [],
  errorMessage: null,
  focusedHintId: null,
  applySnapshot: ({ utterances, hints }) => set({ utterances, hints }),
  upsertUtterance: (utterance) =>
    set((state) => {
      const index = state.utterances.findIndex((u) => u.id === utterance.id)
      if (index === -1) return { utterances: [...state.utterances, utterance] }
      const utterances = [...state.utterances]
      utterances[index] = utterance
      return { utterances }
    }),
  removeUtterance: (id) =>
    set((state) => ({ utterances: state.utterances.filter((u) => u.id !== id) })),
  upsertHint: (card) =>
    set((state) => {
      const index = state.hints.findIndex((h) => h.id === card.id)
      if (index === -1) return { hints: [...state.hints, card] }
      const hints = [...state.hints]
      hints[index] = card
      return { hints }
    }),
  removeHint: (id) =>
    set((state) => ({
      hints: state.hints.filter((h) => h.id !== id),
      focusedHintId: state.focusedHintId === id ? null : state.focusedHintId
    })),
  appendHintText: (chunks) =>
    set((state) => ({
      hints: state.hints.map((h) =>
        chunks.has(h.id) ? { ...h, text: h.text + chunks.get(h.id) } : h
      )
    })),
  clear: () => set({ utterances: [], hints: [], errorMessage: null, focusedHintId: null }),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setFocusedHintId: (focusedHintId) => set({ focusedHintId })
}))
