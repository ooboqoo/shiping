import { create } from 'zustand'

/** One request round: its reasoning, and where its answer text begins */
export interface ReasoningRound {
  /** What the model reasoned in this round; empty for non-thinking models */
  chunks: string[]
  /**
   * Length of the answer text when this round began. Its answer segment is the
   * text from here to the next round's snapshot.
   */
  textStart: number
}

/** A round's collapse state, once the user has clicked its header */
export interface RoundUi {
  open: boolean
  pinned: boolean
}

/** The error banner's headings: an AI request failed, or 截图模式's 语音转录 did */
export const AI_ERROR_TITLE = 'API 调用失败'
export const VOICE_ERROR_TITLE = '语音转录失败'

interface SolutionState {
  isLoading: boolean
  solutionChunks: string[]
  /**
   * Every request — the first screenshot, each appended screenshot, each
   * follow-up — gets a round, so reasoning and answer text stay paired no
   * matter which of the two the model produced. Round 0 exists from the moment
   * the conversation is cleared; later rounds are opened by
   * `reasoning-round-start`. A round without reasoning shows no block but
   * still owns its answer segment.
   *
   * These live in the store rather than component state because the page is
   * unmounted whenever the user visits the settings — the conversation must
   * survive that round trip intact.
   */
  reasoningRounds: ReasoningRound[]
  /** The round reasoning chunks are currently landing in; null when none */
  liveRound: number | null
  /** Collapse state the user chose per round; rounds not here follow the stream */
  roundUi: Record<number, RoundUi>
  screenshotData: string | null
  /**
   * The conversation's thumbnails, as main last sent them (it keeps the last 5).
   * In the store for the same reason as the rounds: the page remounts after a
   * visit to the settings, and main only resends them with the next screenshot
   */
  recentScreenshots: string[]
  /** Every screenshot sent to the AI, which can exceed the thumbnails kept around */
  screenshotTotal: number
  errorMessage: string | null
  /** The banner's heading: what failed (an AI request by default, or 语音转录) */
  errorTitle: string
  /** How long the last request took, in ms; null until one has finished */
  durationMs: number | null
}

interface SolutionStore extends SolutionState {
  setIsLoading: (isReceiving: boolean) => void
  addSolutionChunk: (chunk: string) => void
  /** Append to the last round, which becomes the live one */
  addReasoningChunk: (chunk: string) => void
  /** Open a round for the next request, whose answer text starts at `textStart` */
  startReasoningRound: (textStart: number) => void
  setLiveRound: (index: number | null) => void
  /** The user clicked a round's header: pin it to the state they picked */
  setRoundOpen: (index: number, open: boolean) => void
  setSolutionChunks: (chunks: string[]) => void
  setScreenshotData: (data: string | null) => void
  setRecentScreenshots: (screenshots: string[], total: number) => void
  /** `title` heads the banner, `AI_ERROR_TITLE` when absent */
  setErrorMessage: (message: string | null, title?: string) => void
  setDurationMs: (ms: number | null) => void
  clearSolution: () => void
  resetState: () => void
}

const defaultState: SolutionState = {
  isLoading: false,
  solutionChunks: [],
  reasoningRounds: [],
  liveRound: null,
  roundUi: {},
  screenshotData: null,
  recentScreenshots: [],
  screenshotTotal: 0,
  errorMessage: null,
  errorTitle: AI_ERROR_TITLE,
  durationMs: null
}

export const useSolutionStore = create<SolutionStore>()((set) => ({
  ...defaultState,
  setIsLoading: (isReceiving) => {
    set({ isLoading: isReceiving })
  },
  addSolutionChunk: (chunk) => {
    set((state) => ({
      solutionChunks: [...state.solutionChunks, chunk]
    }))
  },
  addReasoningChunk: (chunk) => {
    set((state) => {
      // A stream that somehow began without a clear still gets a round to land in
      const rounds =
        state.reasoningRounds.length > 0 ? state.reasoningRounds : [{ chunks: [], textStart: 0 }]
      const index = rounds.length - 1
      const last = rounds[index]
      return {
        reasoningRounds: [...rounds.slice(0, index), { ...last, chunks: [...last.chunks, chunk] }],
        liveRound: index
      }
    })
  },
  startReasoningRound: (textStart) => {
    set((state) => ({
      reasoningRounds: [...state.reasoningRounds, { chunks: [], textStart }],
      liveRound: null
    }))
  },
  setLiveRound: (index) => {
    set({ liveRound: index })
  },
  setRoundOpen: (index, open) => {
    set((state) => ({
      roundUi: { ...state.roundUi, [index]: { open, pinned: true } }
    }))
  },
  setSolutionChunks: (chunks) => {
    set({ solutionChunks: chunks })
  },
  setScreenshotData: (data) => {
    set({ screenshotData: data })
  },
  setRecentScreenshots: (screenshots, total) => {
    set({ recentScreenshots: screenshots, screenshotTotal: total })
  },
  setErrorMessage: (message, title = AI_ERROR_TITLE) => {
    set({ errorMessage: message, errorTitle: title })
  },
  setDurationMs: (ms) => {
    set({ durationMs: ms })
  },
  clearSolution: () => {
    // A new conversation: the previous screenshots, chunks and timing no longer
    // apply, and round 0 opens so the text to come is paired with the reasoning
    // to come
    set({
      screenshotData: null,
      recentScreenshots: [],
      screenshotTotal: 0,
      solutionChunks: [],
      reasoningRounds: [{ chunks: [], textStart: 0 }],
      liveRound: null,
      roundUi: {},
      isLoading: false,
      errorMessage: null,
      durationMs: null
    })
  },
  resetState: () => {
    set(defaultState)
  }
}))
