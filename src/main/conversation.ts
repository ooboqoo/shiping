import { app, ipcMain } from 'electron'
import type { ModelMessage } from 'ai'
import { getHintStream, getMemoStream, getPrewarmStream } from './ai'
import { settings, getModeProfile, onSettingsChanged } from './settings'
import { saveConversation, saveConversationSync } from './save-conversation'
import { consumeStream, extractErrorMessage } from './stream'
import {
  isTranscriptionRunning,
  onConversationSentence,
  onTranscriptionEnd,
  onTranscriptionError,
  onTranscriptionStart
} from './transcription'
import { markMobileDirty, registerMobileSource } from './mobile-sync'
import {
  countMeaningfulChars,
  looksLikeQuestion,
  NO_REPLY,
  type ConversationSnapshot,
  type AudioSource,
  type HintCard,
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
 *   written again into the same card once they finish. A sentence that reads
 *   as a question starts its hint earlier still, once the recogniser has had
 *   nothing new for `EARLY_IDLE` (see `scheduleEarlyHint`).
 * - by the shortcut or the button, in either mode: it covers everything not yet
 *   hinted, including a sentence still being spoken, or rewrites the last hint
 *   when nothing new was said.
 */

/** How much earlier conversation goes along as context, whichever runs out first */
const CONTEXT_UTTERANCES = 20
const CONTEXT_CHARS = 1500

/**
 * The 外部知识库 searches with the sentences a hint is for; shorter than this
 * (「那它呢？」) and the sentence before goes along, so there is something to find
 */
const SHORT_QUERY_CHARS = 20

/**
 * The latest hints go along too, cut short, so the next one follows on from
 * them instead of saying the same again
 */
const CONTEXT_HINTS = 2
const CONTEXT_HINT_CHARS = 160

/**
 * A rolling memo of the call keeps what the context window has let go of: what
 * was asked, what the other side told about themselves, what the hints have
 * claimed. The same model folds sentences into it a few at a time, off the
 * hints' path. The latest ones (`MEMO_KEEP` sentences / `MEMO_KEEP_CHARS`,
 * whichever runs out first) stay out: their hints may still be rewritten, and
 * the context window has them word for word.
 */
const MEMO_KEEP = 8
const MEMO_KEEP_CHARS = 600
/** Sentences gather until there are this many, or this many characters, before a fold */
const MEMO_BATCH = 4
const MEMO_BATCH_CHARS = 300
const MEMO_CHARS = 800
const MEMO_HINT_CHARS = 300
/** After a failed fold; the sentences wait meanwhile, still within the context window */
const MEMO_RETRY = 30_000
const MEMO_SYSTEM = [
  '你在为一位正在通话（多为面试）的用户维护对话备忘。把【新的一段对话】合并进【当前备忘】，输出更新后的完整备忘。',
  '「对方」是通话另一方说的话；「提示」是给用户的回答建议，用户大致会照着说。',
  '「我（实际回答）」是用户真实说过的话，不能当成对方的问题；与提示建议有差别时，以实际回答为准记入【已给出的说法】。',
  '固定四节，没有内容的节写「无」：',
  '【对方问过的问题】每题一行，最新的在最后',
  '【对方透露的信息】公司、岗位、团队、项目、要求等',
  '【已给出的说法】提示里说过的经历、数字、立场，后面的提示不能与之矛盾',
  '【对方关注点】从提问推断',
  `合并去重，不超过 ${MEMO_CHARS - 100} 字，超长时先删最早的问题。只输出备忘本身，不要解释。`
].join('\n')

/**
 * While listening, the system prompt is sent again after this long without a
 * request, before the platform's cache of it runs cold (OpenAI keeps it 5-10
 * minutes)
 */
const PREWARM_IDLE = 4 * 60_000
const PREWARM_CHECK = 60_000
/** A prewarm that has not answered by then is given up */
const PREWARM_TIMEOUT = 30_000

/**
 * A question still being spoken whose text stopped changing for this long gets
 * its hint before the recogniser ends the sentence (`conversationSilenceMs`,
 * 0.8s by default): the other side has most likely finished asking.
 */
const EARLY_IDLE = 350
/** Revisions this small (a homophone fixed) leave a hint started early standing */
const EARLY_SLACK = 1
/** A question needs only this many characters to trigger, however high the minimum: 「为什么？」 */
const QUESTION_MIN_CHARS = 2

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
/** Why recognition last failed while listening; cleared when it starts again */
let listenError: string | undefined
/** The last save failed and the user was told; not again until one succeeds */
let saveFailed = false

let memo = ''
/** The last utterance folded into `memo` */
let memoUpTo = 0
/** The fold being written; a clear drops it */
let memoController: AbortController | null = null
let memoRetryAt = 0

/** When 对话模式 last sent its system prompt, with a hint or a prewarm */
let lastRequestAt = 0
let keepWarmTimer: NodeJS.Timeout | null = null

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

/**
 * Cards started before their last sentence was final, by card id: that
 * sentence, and its length then. Growing past it means the other side was not
 * done after all, and the card is written again.
 */
const earlyStarts = new Map<number, { utteranceId: number; chars: number }>()
let earlyTimer: NodeJS.Timeout | null = null
/** The open sentence the timer waits on, as it read when the timer was set */
let earlyCandidate: { id: number; text: string } | null = null

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

/** Whether a sentence is worth a hint by itself; short questions count, 「好的」「嗯」 do not */
function enoughToAnswer(text: string): boolean {
  const needed = looksLikeQuestion(text) ? Math.min(minChars(), QUESTION_MIN_CHARS) : minChars()
  return countMeaningfulChars(text) >= needed
}

/** The sentence the recogniser is still revising, if any */
function openUtterance(source: AudioSource = 'system'): Utterance | undefined {
  return utterances.findLast((u) => !u.final && (u.source ?? 'system') === source)
}

function waitingCard(): HintCard | undefined {
  return hints.find((card) => card.status === 'waiting')
}

/** Cut a card's stream short; whoever does so updates the card */
function stopStream(cardId: number) {
  streams.get(cardId)?.controller.abort()
  streams.delete(cardId)
}

function handleSentence(text: string, final: boolean, source?: AudioSource) {
  let utterance = openUtterance(source)
  if (!utterance) {
    // The recogniser reports silence as an empty sentence; nothing to show
    if (!text.trim()) return
    utterance = { id: nextUtteranceId++, text, final, ...(source ? { source } : {}) }
    utterances.push(utterance)
    startedAt ||= Date.now()
  } else {
    utterance.text = text
    utterance.final = final
  }

  if (final && !utterance.text.trim()) {
    utterances.splice(utterances.indexOf(utterance), 1)
    send('conversation-utterance-removed', utterance.id)
    scheduleSave()
    // What withdrew a hint came to nothing: write it for what it had
    const waiting = source !== 'microphone' ? waitingCard() : undefined
    if (waiting) void startHint(waiting, waiting.fromId, waiting.toId, 'auto')
    return
  }
  publishUtterance(utterance)

  // Own speech is history, never a question or an interruption of the other side.
  if (source === 'microphone') {
    if (final) void updateMemo()
    return
  }

  if (final) {
    onSentenceFinished(utterance)
    void updateMemo()
  } else {
    onSentenceGrowing(utterance)
    scheduleEarlyHint(utterance)
  }
}

/** A hint started early whose sentence has since grown by more than a revision */
function outgrown(card: HintCard, utterance: Utterance): boolean {
  const start = earlyStarts.get(card.id)
  return (
    start?.utteranceId === utterance.id &&
    countMeaningfulChars(utterance.text) > start.chars + EARLY_SLACK
  )
}

/**
 * The other side kept talking while an automatic hint was being written: for
 * their previous sentence, or for this one, started early on a pause that
 * turned out to be one. It answers half a question, so it is withdrawn and
 * written again once they finish (see `onSentenceFinished`).
 */
function onSentenceGrowing(utterance: Utterance) {
  if (settings.conversationHintMode !== 'auto') return
  const longEnough = countMeaningfulChars(utterance.text) >= minChars()
  for (const card of hints) {
    if (card.source !== 'auto') continue
    const overtaken = card.status === 'streaming' && utterance.id > card.toId && longEnough
    const early =
      (card.status === 'streaming' || card.status === 'done') && outgrown(card, utterance)
    if (!overtaken && !early) continue
    stopStream(card.id)
    earlyStarts.delete(card.id)
    card.status = 'waiting'
    card.text = ''
    card.reasoning = ''
    card.latencyMs = undefined
    publishHint(card)
  }
}

function cancelEarlyHint() {
  if (earlyTimer) clearTimeout(earlyTimer)
  earlyTimer = null
  earlyCandidate = null
}

/**
 * The recogniser ends a sentence only after `conversationSilenceMs` of
 * silence. A question rarely goes on after a pause, so once its text has not
 * changed for `EARLY_IDLE`, its hint starts then: the same request as at the
 * end of the sentence, only sooner. Should they go on after all, the hint is
 * withdrawn like any other (`onSentenceGrowing`).
 */
function scheduleEarlyHint(utterance: Utterance) {
  // The recogniser repeats a sentence unchanged; that is the silence being waited for
  if (earlyCandidate?.id === utterance.id && earlyCandidate.text === utterance.text) return
  cancelEarlyHint()
  if (settings.conversationHintMode !== 'auto') return
  if (settings.conversationSilenceMs <= EARLY_IDLE) return
  if (!looksLikeQuestion(utterance.text) || !enoughToAnswer(utterance.text)) return
  const waiting = waitingCard()
  if (!waiting && utterance.id <= hintedUpTo) return
  earlyCandidate = { id: utterance.id, text: utterance.text }
  earlyTimer = setTimeout(() => {
    earlyTimer = null
    const open = openUtterance()
    if (open?.id !== utterance.id) return
    // Taken by a newer request (the shortcut) in the meantime
    const card = waitingCard()
    if (!card && open.id <= hintedUpTo) return
    const fromId = card ? card.fromId : hintedUpTo + 1
    void startHint(card ?? createCard(fromId, open.id), fromId, open.id, 'auto', undefined, true)
  }, EARLY_IDLE)
}

function onSentenceFinished(utterance: Utterance) {
  cancelEarlyHint()
  // A withdrawn hint was promised: finish it whatever the mode is by now
  const waiting = waitingCard()
  if (waiting) {
    void startHint(waiting, waiting.fromId, utterance.id, 'auto')
    return
  }
  // Started early on this sentence: it stands, unless the final text says more
  const early = hints.find((card) => earlyStarts.get(card.id)?.utteranceId === utterance.id)
  if (early) {
    const rewrite =
      (early.status === 'streaming' || early.status === 'done') && outgrown(early, utterance)
    earlyStarts.delete(early.id)
    if (rewrite) void startHint(early, early.fromId, utterance.id, 'auto')
    return
  }
  if (settings.conversationHintMode !== 'auto') return
  if (utterance.id <= hintedUpTo) return
  // 「好的」「嗯」: nothing to answer. The sentences skipped here still go along
  // with the next hint, as part of what it covers
  if (!enoughToAnswer(utterance.text)) return
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

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A hint worth remembering: finished, and with something to say */
function answered(card: HintCard): boolean {
  return card.status === 'done' && !!card.text.trim() && !card.text.includes(NO_REPLY)
}

/** The latest hints written for earlier sentences, each cut to its start (the opening line comes first) */
function recentHints(fromId: number): string[] {
  return hints
    .filter((card) => card.toId < fromId && answered(card))
    .slice(-CONTEXT_HINTS)
    .map((card) => cut(card.text.trim(), CONTEXT_HINT_CHARS))
}

/** The last sentence the memo may take in: all but the latest few, and never part of a card */
function memoBoundary(): number {
  let upTo = 0
  let kept = 0
  let keptChars = 0
  for (let i = utterances.length - 1; i >= 0; i--) {
    if (kept >= MEMO_KEEP || keptChars >= MEMO_KEEP_CHARS) {
      upTo = utterances[i].id
      break
    }
    kept++
    keptChars += utterances[i].text.length
  }
  // A card goes in with all its sentences once it is settled, or not yet
  for (const card of [...hints].reverse()) {
    const unsettled = card.status === 'streaming' || card.status === 'waiting'
    if (card.fromId <= upTo && (card.toId > upTo || unsettled)) upTo = card.fromId - 1
  }
  // Independent speakers can leave an older sentence open while the other continues.
  const open = utterances.find((u) => !u.final)
  if (open) upTo = Math.min(upTo, open.id - 1)
  return upTo
}

/** Sentences after the memo up to `upTo`, each followed by the hint written for it */
function memoTranscript(upTo: number): string {
  const lines: string[] = []
  for (const utterance of utterances) {
    if (utterance.id <= memoUpTo || utterance.id > upTo || !utterance.text.trim()) continue
    lines.push(
      `${utterance.source === 'microphone' ? '我（实际回答）' : '对方'}：${utterance.text.trim()}`
    )
    for (const card of hints) {
      if (card.toId === utterance.id && answered(card)) {
        lines.push(`提示：${cut(card.text.trim(), MEMO_HINT_CHARS)}`)
      }
    }
  }
  return lines.join('\n')
}

/** Fold the sentences the context window is about to let go of into the memo */
async function updateMemo(): Promise<void> {
  if (memoController || Date.now() < memoRetryAt) return
  if (!getModeProfile('conversation').apiKey) return
  const upTo = memoBoundary()
  const fresh = utterances.filter((u) => u.id > memoUpTo && u.id <= upTo && u.text.trim())
  const freshChars = fresh.reduce((sum, u) => sum + u.text.length, 0)
  if (fresh.length < MEMO_BATCH && freshChars < MEMO_BATCH_CHARS) return

  const controller = new AbortController()
  memoController = controller
  const prompt = `【当前备忘】\n${memo || '（空）'}\n\n【新的一段对话】\n${memoTranscript(upTo)}`
  const outcome = await consumeStream(
    (signal) => getMemoStream(MEMO_SYSTEM, prompt, signal),
    controller,
    () => {}
  )
  // The conversation was cleared meanwhile
  if (memoController !== controller) return
  memoController = null
  const text = outcome.text.trim()
  if (outcome.status !== 'complete' || !text) {
    if (outcome.status === 'failed') {
      console.error('Error updating the conversation memo:', outcome.error)
    }
    memoRetryAt = Date.now() + MEMO_RETRY
    return
  }
  memo = cut(text, MEMO_CHARS)
  memoUpTo = upTo
  // More may have fallen behind while this one was written
  void updateMemo()
}

function resetMemo() {
  memoController?.abort()
  memoController = null
  memo = ''
  memoUpTo = 0
  memoRetryAt = 0
}

/**
 * Send the system prompt ahead of the next hint (see `getPrewarmStream`), cut
 * off at its first chunk. Failures stay silent: the hint itself will tell.
 */
function prewarm() {
  if (!getModeProfile('conversation').apiKey) return
  lastRequestAt = Date.now()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), PREWARM_TIMEOUT)
  void consumeStream(getPrewarmStream, controller, () => controller.abort()).then((outcome) => {
    if (outcome.status === 'failed') console.error('Error prewarming:', outcome.error)
  })
}

function startKeepWarm() {
  stopKeepWarm()
  prewarm()
  keepWarmTimer = setInterval(() => {
    if (Date.now() - lastRequestAt >= PREWARM_IDLE) prewarm()
  }, PREWARM_CHECK)
}

function stopKeepWarm() {
  if (keepWarmTimer) clearInterval(keepWarmTimer)
  keepWarmTimer = null
}

/**
 * The request for one hint: earlier sentences and the latest hints as
 * context, then the ones the hint is for. `previous` asks for a different take
 * on an earlier hint. `early`: the last sentence is not final yet, but read as
 * a finished question (see `scheduleEarlyHint`), so it is not marked unfinished.
 */
function buildMessages(
  fromId: number,
  toId: number,
  previous?: string,
  early = false
): ModelMessage[] {
  const context: string[] = []
  let chars = 0
  const earlier = utterances.filter(
    (u) => u.text.trim() && (u.id < fromId || u.source === 'microphone')
  )
  const hasSelf = earlier.some((u) => u.source === 'microphone')
  // Most recent first, until the budget runs out
  for (let i = earlier.length - 1; i >= 0 && context.length < CONTEXT_UTTERANCES; i--) {
    const text = hasSelf
      ? `${earlier[i].source === 'microphone' ? '我（实际回答）' : '对方'}：${earlier[i].text}`
      : earlier[i].text
    chars += text.length
    if (chars > CONTEXT_CHARS && context.length > 0) break
    context.unshift(text)
  }

  const focus = utterances.filter(
    (u) => u.source !== 'microphone' && u.id >= fromId && u.id <= toId && u.text.trim()
  )
  const unfinished = !early && focus.length > 0 && !focus[focus.length - 1].final
  const given = recentHints(fromId)

  const parts: string[] = []
  if (memo && fromId > memoUpTo) {
    parts.push(`【更早对话的备忘】（前面对话的摘要，提示要与其中的说法保持一致）\n${memo}`)
  }
  if (context.length > 0)
    parts.push(
      `${hasSelf ? '【之前对话原文】（我（实际回答）是用户说过的话）' : '【之前对方说过的话】'}\n${context.join('\n')}`
    )
  if (given.length > 0) {
    parts.push(
      `【你最近给过的提示（节选）】\n${given.join('\n---\n')}\n\n对方若是追问，接着这个思路往下说；不要重复已经给过的内容。`
    )
  }
  parts.push(
    `【对方刚才说的话】${unfinished ? '（还没说完）' : ''}\n${focus.map((u) => u.text).join('\n')}`
  )
  if (previous?.trim()) {
    parts.push(`【上一版提示】\n${previous}\n\n请换一个角度重新给出提示，不要重复上一版。`)
  }
  return [{ role: 'user', content: parts.join('\n\n') }]
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

/**
 * Write (or rewrite) `card` for utterances `fromId`..`toId`. `early`: before
 * the recogniser has ended the last of them (see `scheduleEarlyHint`)
 */
async function startHint(
  card: HintCard,
  fromId: number,
  toId: number,
  source: HintCard['source'],
  previous?: string,
  early = false
): Promise<void> {
  stopStream(card.id)
  earlyStarts.delete(card.id)
  const last = utterances.find((u) => u.id === toId)
  if (early && last) {
    earlyStarts.set(card.id, { utteranceId: toId, chars: countMeaningfulChars(last.text) })
  }
  Object.assign(card, {
    fromId,
    toId,
    source,
    status: 'streaming',
    text: '',
    reasoning: '',
    error: undefined,
    latencyMs: undefined
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
  lastRequestAt = stream.startedAt
  const messages = buildMessages(fromId, toId, previous, early)
  const query = hintQuery(fromId, toId)
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
      card.latencyMs ??= Date.now() - stream.startedAt
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
}

/**
 * The shortcut / button: a hint now. Brings the card being written (or waiting)
 * up to date, else opens one for everything not yet hinted, else rewrites the
 * last hint.
 */
export function requestHint(): void {
  const latest = utterances.findLast((u) => u.source !== 'microphone')
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
  if (last) {
    void startHint(last, last.fromId, last.toId, 'manual', last.text)
    return
  }
  send('conversation-notice', '还没有识别到对方说话')
}

/** Stop every hint being written, and give up on the withdrawn ones */
export function stopHints(): void {
  cancelEarlyHint()
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
  for (const id of [...streams.keys()]) stopStream(id)
  cancelEarlyHint()
  earlyStarts.clear()
  resetMemo()
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
    })),
    listening: isTranscriptionRunning('conversation'),
    listenError
  }
})

onConversationSentence(handleSentence)

onTranscriptionStart((purpose) => {
  if (purpose !== 'conversation') return
  listenError = undefined
  markMobileDirty()
  startKeepWarm()
})

onTranscriptionError((message) => {
  if (!isTranscriptionRunning('conversation')) return
  listenError = message
  markMobileDirty()
})

// Stopping mid-sentence keeps what was heard: the recogniser will not finish it now
onTranscriptionEnd(() => {
  cancelEarlyHint()
  stopKeepWarm()
  markMobileDirty()
  // ASR may have drained the other side already while own speech remains open.
  const open = openUtterance()
  for (const utterance of utterances.filter((u) => !u.final)) {
    utterance.final = true
    publishUtterance(utterance)
  }
  const waiting = waitingCard()
  if (waiting)
    void startHint(waiting, waiting.fromId, Math.max(waiting.toId, open?.id ?? 0), 'auto')
})

// Turned on (or pointed at another folder) mid-conversation: save what is there already
onSettingsChanged((previous) => {
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
