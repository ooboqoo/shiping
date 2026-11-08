/**
 * 手机同步: what main publishes to the phones, and how the sync is doing.
 *
 * `MobileState` is what relay/public/app.js reads; the relay passes it through
 * untouched. Bump `v` only when a field changes meaning, so an old page open on
 * a phone can tell. A new field needs no bump: the page ignores what it does not
 * know.
 */

import type { AppMode } from './api-profile'
import type { HintCard, Utterance } from './conversation'

export interface MobileAnswer {
  /** Bumped by every new screenshot (a new question); the page scrolls back to the top */
  id: number
  status: 'idle' | 'streaming' | 'done' | 'stopped' | 'error'
  /** The whole answer so far, follow-ups and appended screenshots included */
  text: string
  error?: string
  screenshots: number
}

export interface MobileConversation {
  utterances: Utterance[]
  hints: Pick<HintCard, 'id' | 'fromId' | 'toId' | 'status' | 'text' | 'error'>[]
  /**
   * Whether the other side is being listened to. With the main window folded
   * into the 极简悬浮条 the phone is the only place a recognition that stopped
   * by itself can be noticed
   */
  listening: boolean
  /** Why recognition last failed, until it is started again */
  listenError?: string
}

export interface MobileState {
  v: 1
  /** The mode page on screen, or the last one that was */
  mode: AppMode
  /**
   * Page-down minus page-up presses on the desktop since the app started. A
   * phone pages by how much it changed, never by its value: the first state a
   * connection gets only sets where it counts from
   */
  paging: number
  screenshot: MobileAnswer
  conversation: MobileConversation
}

export type MobileLinkState = 'off' | 'starting' | 'on' | 'error'

export interface MobileSyncStatus {
  lan: {
    state: MobileLinkState
    /** One viewer URL per local address, likeliest first; empty unless running */
    urls: string[]
    viewers: number
    /** How many phones may watch at once; unknown until running */
    maxViewers?: number
    error?: string
  }
  relay: {
    state: MobileLinkState
    /** The viewer URL; blank unless the relay URL and key are usable */
    url: string
    viewers: number
    /** The relay's MAX_VIEWERS; unknown until connected, and from a relay older than this field */
    maxViewers?: number
    error?: string
  }
}
