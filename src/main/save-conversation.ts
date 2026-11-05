import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { conversationSaveDir } from './settings'
import { NO_REPLY, type HintCard, type Utterance } from '../shared/conversation'

/**
 * 对话模式's record on disk: one Markdown file per conversation, named after
 * when it began and rewritten whole as it grows, so the file always holds the
 * entire conversation so far.
 */

export interface ConversationRecord {
  /** When the first sentence was heard; the file is named after it */
  startedAt: number
  utterances: Utterance[]
  hints: HintCard[]
}

const pad = (n: number) => String(n).padStart(2, '0')

function fileName(startedAt: number): string {
  const d = new Date(startedAt)
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `对话记录_${date}_${time}.md`
}

function title(startedAt: number): string {
  const d = new Date(startedAt)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `# 对话记录 ${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function hintLabel(card: HintCard): string {
  if (card.status === 'stopped') return '**提示**（已停止）'
  if (card.status === 'streaming') return '**提示**（未写完）'
  return '**提示**'
}

/**
 * The conversation as rounds: what the other side said, as a quote, then the
 * hint written for it. Hints with nothing to keep (failed, withdrawn,
 * 「（无需回应）」) are left out, and the sentences they covered join the next
 * round. Null when nothing has been said yet.
 */
export function formatConversation({
  startedAt,
  utterances,
  hints
}: ConversationRecord): string | null {
  const spoken = utterances.filter((u) => u.text.trim())
  const shown = hints
    .filter((card) => {
      const text = card.text.trim()
      return card.status !== 'waiting' && card.status !== 'error' && text && text !== NO_REPLY
    })
    .sort((a, b) => a.toId - b.toId)
  if (spoken.length === 0 && shown.length === 0) return null

  const rounds: string[] = []
  let heard: string[] = []
  const closeRound = (card?: HintCard) => {
    const parts: string[] = []
    if (heard.length > 0) {
      parts.push('**对方**', heard.map((text) => `> ${text}`).join('\n>\n'))
    }
    if (card) parts.push(hintLabel(card), card.text.trim())
    rounds.push(parts.join('\n\n'))
    heard = []
  }

  let next = 0
  for (const utterance of spoken) {
    while (next < shown.length && shown[next].toId < utterance.id) closeRound(shown[next++])
    // A sentence is one line from the recogniser; a stray line break would end the quote
    heard.push(utterance.text.trim().replace(/\s*\n\s*/g, ' '))
  }
  while (next < shown.length) closeRound(shown[next++])
  if (heard.length > 0) closeRound()

  return `${title(startedAt)}\n\n${rounds.join('\n\n---\n\n')}\n`
}

/** Writes in the order they were asked for, so an older record never lands over a newer one */
let queue: Promise<void> = Promise.resolve()

/**
 * Write the record to the configured folder. The content is taken at once, so
 * the conversation may change (or be cleared) while the write is queued.
 */
export function saveConversation(record: ConversationRecord): Promise<void> {
  const content = formatConversation(record)
  if (!content) return Promise.resolve()
  const dir = conversationSaveDir()
  const filePath = join(dir, fileName(record.startedAt))
  const write = queue.then(async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, content, 'utf8')
  })
  queue = write.catch(() => {})
  return write
}

/** The same, for when the app is quitting and cannot wait for a promise */
export function saveConversationSync(record: ConversationRecord): void {
  const content = formatConversation(record)
  if (!content) return
  const dir = conversationSaveDir()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, fileName(record.startedAt)), content, 'utf8')
  } catch (error) {
    console.error('Failed to save the conversation:', error)
  }
}
