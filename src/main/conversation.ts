import { app, ipcMain } from 'electron'
import type { ModelMessage } from 'ai'
import { getHintStream, summarizeConversation } from './ai'
import { SummaryQueue } from './conversation-summaries'
import { buildBackground, fitTokens, normalizeContextOptions } from '../shared/conversation-context'
import { estimateTokens } from '../shared/knowledge'
import { settings, getModeProfile, onSettingsChanged } from './settings'
import { saveConversation, saveConversationSync } from './save-conversation'
import { consumeStream, extractErrorMessage } from './stream'
import { isTranscriptionRunning, onConversationSentence, onTranscriptionEnd } from './transcription'
import { markMobileDirty, registerMobileSource } from './mobile-sync'
import {
  countMeaningfulChars,
  NO_REPLY,
  type ConversationSnapshot,
  type HintCard,
  type AudioSource,
  type Utterance
} from '../shared/conversation'

/**
 * 对话模式: what the other side of a call says, sentence by sentence, and the
 * hints written for it. Main owns both so that leaving the page (for the
 * settings, say) loses nothing; the renderer asks for a snapshot when it comes
 * back and follows the events after that.
 *
 * Hints are asked for in two ways:
 * - automatically, when a sentence ends (`conversationHintMode: 'auto'`). The
 *   request goes out at once rather than after a grace period; if the other
 *   side turns out to still be talking, the hint is withdrawn (`waiting`) and
 *   written again into the same card once they finish.
 * - by the shortcut or the button, in either mode: it covers everything not yet
 *   hinted, including a sentence still being spoken, or rewrites the last hint
 *   when nothing new was said.
 */

/** How much earlier conversation goes along as context, whichever runs out first */
const summaryQueue = new SummaryQueue(summarizeConversation)

function contextOptions() {
  return normalizeContextOptions({
    enabled: settings.conversationContextEnabled,
    rounds: settings.conversationContextRounds,
    tokenBudget: settings.conversationContextTokenBudget
  })
}

/**
 * The 外部知识库 searches with the sentences a hint is for; shorter than this
 * (「那它呢？」) and the sentence before goes along, so there is something to find
 */
const SHORT_QUERY_CHARS = 20

/** The phones get the latest hints and what they answer, not the whole call */
const MOBILE_HINTS = 20
const MOBILE_UTTERANCES = 60

/** How long changes gather before the record on disk is rewritten */
const SAVE_DELAY = 1500

let utterances: Utterance[] = []
let hints: HintCard[] = []
let nextUtteranceId = 1
let nextHintId = 1
/** The last utterance some hint has covered; later ones are still unanswered */
let hintedUpTo = 0
/** When the first sentence was heard; the saved record is named after it */
let startedAt = 0
let saveTimer: NodeJS.Timeout | null = null
/** The last save failed and the user was told; not again until one succeeds */
let saveFailed = false

interface HintStream {
  controller: AbortController
  startedAt: number
}

/** Streams in flight, by card id: a new question may arrive while an earlier hint is still being written */
const streams = new Map<number, HintStream>()

/**
 * Bumped every time a card is (re)started, so a stream that lost its card to a
 * newer request, or to a cleared conversation, never writes to it again. Never
 * reset: card ids start over after a clear.
 */
const generations = new Map<number, number>()

/** Tell the page, and the phones; every change to the conversation goes through here */
function send(channel: string, ...args: unknown[]) {
  markMobileDirty()
  const mainWindow = global.mainWindow
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function publishUtterance(utterance: Utterance) {
  send('conversation-utterance', { ...utterance })
  scheduleSave()
}

function publishHint(card: HintCard) {
  send('conversation-hint', { ...card })
  scheduleSave()
}

/**
 * Rewrite the record on disk shortly. Changes come in bursts (a sentence is
 * revised word by word), and one write covers them all.
 */
function scheduleSave() {
  if (saveTimer || !settings.conversationAutoSave) return
  saveTimer = setTimeout(saveNow, SAVE_DELAY)
}

function saveNow() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!settings.conversationAutoSave) return
  saveConversation({ startedAt, utterances, hints }).then(
    () => {
      saveFailed = false
    },
    (error) => {
      console.error('Failed to save the conversation:', error)
      if (!saveFailed) send('conversation-notice', '对话记录保存失败，请检查设置里的保存目录')
      saveFailed = true
    }
  )
}

function minChars(): number {
  return settings.conversationMinChars || 1
}

/** The sentence the recogniser is still revising, if any */
function openUtterance(source: AudioSource = 'system'): Utterance | undefined {
  return utterances.findLast((u) => (u.source ?? 'system') === source && !u.final)
}

function waitingCard(): HintCard | undefined {
  return hints.find((card) => card.status === 'waiting')
}

/** Cut a card's stream short; whoever does so updates the card */
function stopStream(cardId: number) {
  streams.get(cardId)?.controller.abort()
  streams.delete(cardId)
}

function handleSentence(text: string, final: boolean, source: AudioSource = 'system') {
  if (source === 'system' && text.trim()) summaryQueue.pause()
  let utterance = openUtterance(source)
  if (!utterance) {
    // The recogniser reports silence as an empty sentence; nothing to show
    if (!text.trim()) return
    utterance = { id: nextUtteranceId++, text, final, source }
    utterances.push(utterance)
    startedAt ||= Date.now()
  } else {
    utterance.text = text
    utterance.final = final
  }

  utterance.updatedAt = Date.now()
  if (final) utterance.finalAt = Date.now()
  if (final && !utterance.text.trim()) {
    utterances = utterances.filter((u) => u.id !== utterance!.id)
    send('conversation-utterance-removed', utterance.id)
    scheduleSave()
    // What withdrew a hint came to nothing: write it for what it had
    const waiting = waitingCard()
    if (source === 'system' && waiting)
      void startHint(waiting, waiting.fromId, waiting.toId, 'auto')
    return
  }
  publishUtterance(utterance)

  if (source === 'microphone') return
  if (final) onSentenceFinished(utterance)
  else onSentenceGrowing(utterance)
  if (final && !streams.size && !waitingCard() && contextOptions().enabled) summaryQueue.resume()
}

/**
 * The other side kept talking while an automatic hint for their previous
 * sentence was being written: it answers half a question, so it is withdrawn
 * and written again once they finish (see `onSentenceFinished`).
 */
function onSentenceGrowing(utterance: Utterance) {
  if (settings.conversationHintMode !== 'auto') return
  if (countMeaningfulChars(utterance.text) < minChars()) return
  for (const card of hints) {
    if (card.source !== 'auto' || card.status !== 'streaming' || utterance.id <= card.toId) continue
    stopStream(card.id)
    card.status = 'waiting'
    card.text = ''
    card.reasoning = ''
    card.latencyMs = undefined
    publishHint(card)
  }
}

function onSentenceFinished(utterance: Utterance) {
  // A withdrawn hint was promised: finish it whatever the mode is by now
  const waiting = waitingCard()
  if (waiting) {
    void startHint(waiting, waiting.fromId, utterance.id, 'auto')
    return
  }
  if (settings.conversationHintMode !== 'auto') return
  if (utterance.id <= hintedUpTo) return
  // 「好的」「嗯」: nothing to answer. The sentences skipped here still go along
  // with the next hint, as part of what it covers
  if (countMeaningfulChars(utterance.text) < minChars()) return
  void startHint(createCard(hintedUpTo + 1, utterance.id), hintedUpTo + 1, utterance.id, 'auto')
}

function createCard(fromId: number, toId: number): HintCard {
  const card: HintCard = {
    id: nextHintId++,
    fromId,
    toId,
    source: 'auto',
    status: 'streaming',
    text: '',
    reasoning: ''
  }
  hints.push(card)
  return card
}

/**
 * The request for one hint: earlier sentences as context, then the ones the
 * hint is for. `previous` asks for a different take on an earlier hint.
 */
function buildMessages(fromId: number, toId: number, previous?: string): ModelMessage[] {
  const nextQuestion = utterances.find((u) => u.source !== 'microphone' && u.id > toId)
  const self = utterances
    .filter(
      (u) =>
        u.source === 'microphone' &&
        u.id >= fromId &&
        u.id < (nextQuestion?.id ?? Infinity) &&
        u.text.trim()
    )
    .map((u) => u.text)
    .join('\n')
  const context = buildBackground({
    hints,
    utterances,
    summaries: summaryQueue.summaries,
    fromId,
    self,
    previous,
    ...contextOptions()
  })
  const focus = utterances.filter(
    (u) => u.id >= fromId && u.id <= toId && u.source !== 'microphone' && u.text.trim()
  )
  const unfinished = focus.length > 0 && !focus[focus.length - 1].final

  const parts: string[] = []
  if (context) parts.push(context)
  parts.push(
    `【对方刚才说的话】${unfinished ? '（还没说完）' : ''}\n${focus.map((u) => u.text).join('\n')}`
  )
  return [
    {
      role: 'user',
      content:
        parts.join('\n\n') +
        '\n\n优先直接回答【对方刚才说的话】，先给有用结论，再补充必要解释。历史摘要和我的实际发言只用于理解指代、延续话题，不能替代当前问题。'
    }
  ]
}

/** What the 外部知识库 is asked for a hint on `fromId`..`toId`, see `SHORT_QUERY_CHARS` */
function hintQuery(fromId: number, toId: number): string {
  const spoken = utterances.filter(
    (u) => u.source !== 'microphone' && u.id <= toId && u.text.trim()
  )
  const focus = spoken.filter((u) => u.id >= fromId).map((u) => u.text.trim())
  const before = spoken.filter((u) => u.id < fromId).at(-1)
  if (before && focus.join('').length < SHORT_QUERY_CHARS) focus.unshift(before.text.trim())
  return focus.join('\n')
}

/** Write (or rewrite) `card` for utterances `fromId`..`toId` */
async function startHint(
  card: HintCard,
  fromId: number,
  toId: number,
  source: HintCard['source'],
  previous?: string
): Promise<void> {
  summaryQueue.pause()
  summaryQueue.invalidate(card.id)
  stopStream(card.id)
  Object.assign(card, {
    fromId,
    toId,
    source,
    status: 'streaming',
    text: '',
    reasoning: '',
    error: undefined,
    latencyMs: undefined,
    speechLatencyMs: undefined,
    firstTextAt: undefined,
    visibleLatencyMs: undefined,
    visibleSpeechLatencyMs: undefined,
    requestedAt: Date.now()
  } satisfies Partial<HintCard>)
  hintedUpTo = Math.max(hintedUpTo, toId)
  publishHint(card)

  if (!getModeProfile('conversation').apiKey) {
    card.status = 'error'
    card.error = '对话模式使用的 AI 配置未填写 API Key，请到「设置 → AI 模型」填写'
    publishHint(card)
    return
  }

  const generation = (generations.get(card.id) ?? 0) + 1
  generations.set(card.id, generation)
  const stream: HintStream = { controller: new AbortController(), startedAt: Date.now() }
  streams.set(card.id, stream)
  const messages = buildMessages(fromId, toId, previous)
  const query = hintQuery(fromId, toId)
  const background = String(messages[0].content).split('【对方刚才说的话】')[0]
  card.historyTokens = estimateTokens(background)
  card.historyRounds = (background.match(/【第 \d+ 轮摘要】/g) ?? []).length
  publishHint(card)
  const outcome = await consumeStream(
    (signal) => getHintStream(messages, signal, query),
    stream.controller,
    (chunk) => {
      if (chunk.kind === 'reasoning') {
        // Kept on the card and shipped with its next publish; reasoning is not
        // streamed per-chunk the way the hint text is
        card.reasoning += chunk.delta
        return
      }
      if (!chunk.delta) return
      if (card.firstTextAt === undefined && /[\p{L}\p{N}\p{S}]/u.test(chunk.delta)) {
        card.firstTextAt = Date.now()
        card.latencyMs = card.firstTextAt - stream.startedAt
        const lastQuestion = utterances
          .filter((u) => u.source !== 'microphone' && u.id >= fromId && u.id <= toId)
          .at(-1)
        card.speechLatencyMs = card.firstTextAt - (lastQuestion?.finalAt ?? stream.startedAt)
        publishHint(card)
      }
      card.text += chunk.delta
      send('conversation-hint-chunk', card.id, chunk.delta)
    }
  )
  // A newer request took the card over, or the conversation was cleared
  if (generations.get(card.id) !== generation) return
  streams.delete(card.id)
  // Stopped by the user or withdrawn because the other side kept talking:
  // whoever aborted it has already updated the card
  if (outcome.status === 'aborted') return
  if (outcome.status === 'failed') {
    console.error('Error streaming hint:', outcome.error)
    card.status = 'error'
    card.error = extractErrorMessage(outcome.error)
    publishHint(card)
    return
  }
  card.status = 'done'
  publishHint(card)
  if (
    contextOptions().enabled &&
    contextOptions().rounds &&
    card.text.trim() &&
    card.text.trim() !== NO_REPLY
  ) {
    const question = utterances
      .filter((u) => u.source !== 'microphone' && u.id >= fromId && u.id <= toId)
      .map((u) => u.text)
      .join('\n')
    summaryQueue.enqueue(
      card.id,
      `面试官问题：${fitTokens(question, 1500)}\n我的实际发言：${fitTokens(
        utterances
          .filter((u) => u.source === 'microphone' && u.id >= fromId && u.id <= toId)
          .map((u) => u.text)
          .join('\n'),
        500
      )}\nAI建议（不代表我实际说过）：${fitTokens(card.text, 2000)}`
    )
  }
  if (contextOptions().enabled && !streams.size && !openUtterance()) summaryQueue.resume()
}

/**
 * The shortcut / button: a hint now. Brings the card being written (or waiting)
 * up to date, else opens one for everything not yet hinted, else rewrites the
 * last hint.
 */
export function requestHint(): void {
  const latest = utterances.filter((u) => u.source !== 'microphone').at(-1)
  const current = [...hints]
    .reverse()
    .find((card) => card.status === 'streaming' || card.status === 'waiting')

  if (current) {
    const toId = Math.max(current.toId, latest?.id ?? 0)
    // Already writing exactly this; starting over would only lose what is there
    if (current.status === 'streaming' && toId === current.toId) return
    void startHint(current, current.fromId, toId, 'manual')
    return
  }
  if (latest && latest.id > hintedUpTo) {
    void startHint(createCard(hintedUpTo + 1, latest.id), hintedUpTo + 1, latest.id, 'manual')
    return
  }
  const last = hints.at(-1)
  if (last && latest) {
    void startHint(last, last.fromId, last.toId, 'manual', last.text)
    return
  }
  send('conversation-notice', '还没有识别到对方说话')
}

/** Stop every hint being written, and give up on the withdrawn ones */
export function stopHints(): void {
  for (const card of hints) {
    if (card.status === 'streaming') {
      stopStream(card.id)
      card.status = 'stopped'
      publishHint(card)
    } else if (card.status === 'waiting') {
      card.status = 'stopped'
      publishHint(card)
    }
  }
}

export function clearConversation(): void {
  summaryQueue.clear()
  for (const id of [...streams.keys()]) stopStream(id)
  // The last changes still go into this conversation's file; the next one gets its own
  if (saveTimer) saveNow()
  utterances = []
  hints = []
  nextUtteranceId = 1
  nextHintId = 1
  hintedUpTo = 0
  startedAt = 0
  send('conversation-cleared')
}

function getSnapshot(): ConversationSnapshot {
  return {
    utterances: utterances.map((u) => ({ ...u })),
    hints: hints.map((card) => ({ ...card })),
    listening: isTranscriptionRunning('conversation')
  }
}

registerMobileSource('conversation', () => {
  const recent = hints.slice(-MOBILE_HINTS)
  const from = recent[0]?.fromId ?? 0
  return {
    utterances: utterances
      .filter((u) => u.id >= from)
      .slice(-MOBILE_UTTERANCES)
      .map((u) => ({ ...u })),
    hints: recent.map(({ id, fromId, toId, status, text, error }) => ({
      id,
      fromId,
      toId,
      status,
      text,
      error
    }))
  }
})

onConversationSentence(handleSentence)

// Stopping mid-sentence keeps what was heard: the recogniser will not finish it now
onTranscriptionEnd(() => {
  for (const open of utterances.filter((u) => !u.final)) {
    open.final = true
    open.finalAt = Date.now()
    publishUtterance(open)
  }
  const waiting = waitingCard()
  if (waiting) void startHint(waiting, waiting.fromId, waiting.toId, 'auto')
})

// Turned on (or pointed at another folder) mid-conversation: save what is there already
onSettingsChanged((previous) => {
  if (!contextOptions().enabled) summaryQueue.pause()
  else if (!streams.size) summaryQueue.resume()
  if (!settings.conversationAutoSave) return
  if (
    previous.conversationAutoSave &&
    previous.conversationSaveDir === settings.conversationSaveDir
  ) {
    return
  }
  scheduleSave()
})

// A change still waiting for its save would go down with the process
app.on('will-quit', () => {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  if (settings.conversationAutoSave) saveConversationSync({ startedAt, utterances, hints })
})

ipcMain.handle('conversation:get-snapshot', () => getSnapshot())
ipcMain.handle('conversation:request-hint', () => requestHint())
ipcMain.handle('conversation:stop-hints', () => stopHints())
ipcMain.handle('conversation:clear', () => clearConversation())

ipcMain.handle('conversation:first-visible', (_event, id: number, requestedAt: number) => {
  const card = hints.find((h) => h.id === id && h.requestedAt === requestedAt)
  if (!card || card.firstTextAt === undefined || card.visibleLatencyMs !== undefined) return
  card.visibleLatencyMs = Date.now() - requestedAt
  card.visibleSpeechLatencyMs =
    card.visibleLatencyMs + (card.speechLatencyMs ?? 0) - (card.latencyMs ?? 0)
  publishHint(card)
})
