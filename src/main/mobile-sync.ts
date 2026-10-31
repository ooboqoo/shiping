import { ipcMain } from 'electron'
import { networkInterfaces } from 'node:os'
import WebSocket from 'ws'
import { createRelay, deriveViewerToken, MAX_PAYLOAD, type Relay } from '../../relay/relay.mjs'
import viewerHtml from '../../relay/public/index.html?raw'
import viewerJs from '../../relay/public/app.js?raw'
import viewerCss from '../../relay/public/style.css?raw'
import markedJs from '../../relay/public/vendor/marked.umd.js?raw'
import highlightJs from '../../relay/public/vendor/highlight.min.js?raw'
import { settings, onSettingsChanged } from './settings'
import { state } from './state'
import type { AppMode } from '../shared/api-profile'
import type { MobileState, MobileSyncStatus } from '../shared/mobile'

/**
 * 手机同步: the answers on screen, mirrored to a phone's browser. Two ways out,
 * either or both:
 * - 局域网: the app serves the page itself on LAN_PORT (relay/relay.mjs run
 *   in-process); a phone on the same Wi-Fi scans the QR code.
 * - 公网中转: the app connects to relay/server.mjs on a public server as its
 *   host; the phone opens the page there, from anywhere.
 *
 * The app stays the only source of truth. Whatever changes marks the state
 * dirty; at most every SYNC_INTERVAL the whole state is rebuilt from the
 * registered sources and sent out (see the relay for why whole states).
 */

const LAN_PORT = 8790
const SYNC_INTERVAL = 200
/** The relay pings every 25s; a host that hears nothing for this long reconnects */
const RELAY_SILENCE_LIMIT = 60_000
const RELAY_RETRY_MAX = 30_000
/** Settings arrive on every keystroke in the settings page; act once typing pauses */
const RECONCILE_DELAY = 600
/** Characters of a 截图模式 answer sent to phones: at 3 bytes a CJK one, well under MAX_PAYLOAD */
const MOBILE_TEXT_LIMIT = 100_000

/** The same list as relay/server.mjs serves */
const VIEWER_FILES = {
  '/': { body: viewerHtml, type: 'text/html; charset=utf-8' },
  '/app.js': { body: viewerJs, type: 'text/javascript; charset=utf-8' },
  '/style.css': { body: viewerCss, type: 'text/css; charset=utf-8' },
  '/vendor/marked.umd.js': { body: markedJs, type: 'text/javascript; charset=utf-8' },
  '/vendor/highlight.min.js': { body: highlightJs, type: 'text/javascript; charset=utf-8' }
}

// ---- What is published ----

type SourceKey = Exclude<keyof MobileState, 'v' | 'mode'>
const sources: { [K in SourceKey]?: () => MobileState[K] } = {}

/** Make a part of the state readable; its owner calls `markMobileDirty()` when it changes */
export function registerMobileSource<K extends SourceKey>(key: K, read: () => MobileState[K]) {
  sources[key] = read as (typeof sources)[K]
}

let lastMode: AppMode = 'screenshot'
let paging = 0

/**
 * The desktop's page shortcut pages the phones too, so a phone on a stand can
 * be read without touching it. A count in the state rather than an event:
 * presses within one SYNC_INTERVAL add up, and nothing is replayed on reconnect
 */
export function pageMobile(direction: 1 | -1): void {
  paging += direction
  markMobileDirty()
}

/**
 * The mode page last on screen. Followed even while nothing is synced: the
 * settings page, where sync is switched on, is not a mode page
 */
function noteMode() {
  if (state.inConversationPage) lastMode = 'conversation'
  else if (state.inCoderPage) lastMode = 'screenshot'
}

/**
 * The end of an answer, for the phones. A 截图模式 conversation only grows,
 * and the whole state goes out on every change; past the relay's MAX_PAYLOAD a
 * frame is refused, and resending the same one would never get through. The
 * tail is what is being written, and a code block cut in half is reopened
 */
function tailForPhone(text: string): string {
  if (text.length <= MOBILE_TEXT_LIMIT) return text
  const cut =
    text.indexOf('\n', text.length - MOBILE_TEXT_LIMIT) + 1 || text.length - MOBILE_TEXT_LIMIT
  const fences = text.slice(0, cut).match(/^\s*(```|~~~)/gm)?.length ?? 0
  return `*（前文过长，手机上只显示最后一部分）*\n\n${fences % 2 ? '```\n' : ''}${text.slice(cut)}`
}

function buildState(): MobileState {
  noteMode()
  const screenshot = sources.screenshot?.() ?? { id: 0, status: 'idle', text: '', screenshots: 0 }
  return {
    v: 1,
    mode: lastMode,
    paging,
    screenshot: { ...screenshot, text: tailForPhone(screenshot.text) },
    conversation: sources.conversation?.() ?? { utterances: [], hints: [] }
  }
}

let syncTimer: NodeJS.Timeout | null = null
let lastSyncAt = 0

/** Something the phones show has changed; it goes out within SYNC_INTERVAL */
export function markMobileDirty(): void {
  noteMode()
  if (syncTimer || (!lan && !remote)) return
  syncTimer = setTimeout(flush, Math.max(0, lastSyncAt + SYNC_INTERVAL - Date.now()))
}

function flush() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  lastSyncAt = Date.now()
  const data = buildState()
  lan?.relay.publish(data)
  remote?.send(data)
}

// ---- Status, for the settings page ----

const status: MobileSyncStatus = {
  lan: { state: 'off', urls: [], viewers: 0 },
  relay: { state: 'off', url: '', viewers: 0 }
}

/** Some phone is watching, on either path */
export function hasMobileViewers(): boolean {
  return status.lan.viewers + status.relay.viewers > 0
}

const viewerListeners: (() => void)[] = []
let hadViewers = false

/** Run `listener` whenever phones start or stop watching */
export function onMobileViewersChanged(listener: () => void): void {
  viewerListeners.push(listener)
}

/** Called after every change to a viewer count */
function noteViewers() {
  if (hasMobileViewers() === hadViewers) return
  hadViewers = !hadViewers
  for (const listener of viewerListeners) listener()
}

/**
 * Local IPv4 addresses, likeliest to be the phone's Wi-Fi first: home and
 * office ranges, then the rest; virtual adapters (Hyper-V, WSL, VMs, a proxy's
 * TUN with its 198.18.0.0/15 fake IPs) last.
 */
function lanAddresses(): string[] {
  const virtual =
    /vEthernet|VMware|VirtualBox|vboxnet|Hyper-V|WSL|docker|veth|br-|utun|bridge|Mihomo|Clash|Wintun|\bTAP\b|\bTUN\b/i
  const found: { address: string; rank: number }[] = []
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue
      const a = info.address
      let rank = a.startsWith('192.168.')
        ? 0
        : a.startsWith('10.')
          ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./.test(a)
            ? 2
            : 3
      if (virtual.test(name) || /^198\.1[89]\./.test(a)) rank += 10
      found.push({ address: a, rank })
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map((f) => f.address)
}

function getStatus(): MobileSyncStatus {
  // Recomputed on every read: switching Wi-Fi changes the address under the QR code
  if (lan && status.lan.state === 'on') {
    const token = deriveViewerToken(lan.key)
    status.lan.urls = lanAddresses().map((ip) => `http://${ip}:${LAN_PORT}/#t=${token}`)
  } else {
    status.lan.urls = []
  }
  return structuredClone(status)
}

// ---- 局域网 ----

let lan: { key: string; relay: Relay } | null = null

function startLan(key: string) {
  const relay = createRelay({
    files: VIEWER_FILES,
    viewerToken: deriveViewerToken(key),
    onViewers: (count) => {
      status.lan.viewers = count
      noteViewers()
    }
  })
  const current = { key, relay }
  lan = current
  status.lan = { state: 'starting', urls: [], viewers: 0, maxViewers: relay.maxViewers }
  relay.server.on('error', (error: NodeJS.ErrnoException) => {
    if (lan !== current) return
    console.error('Mobile sync LAN server:', error)
    relay.close()
    lan = null
    status.lan = {
      state: 'error',
      urls: [],
      viewers: 0,
      error:
        error.code === 'EADDRINUSE'
          ? `端口 ${LAN_PORT} 被其他程序占用`
          : `启动失败：${error.message}`
    }
    noteViewers()
  })
  relay.server.listen(LAN_PORT, '0.0.0.0', () => {
    if (lan !== current) return
    status.lan.state = 'on'
    flush()
  })
}

function stopLan() {
  lan?.relay.close()
  lan = null
  status.lan = { state: 'off', urls: [], viewers: 0 }
}

// ---- 公网中转 ----

interface RelayClient {
  id: string
  send: (data: MobileState) => void
  close: () => void
}

let remote: RelayClient | null = null

const TOO_LARGE = '内容超过中转服务的单条上限，暂停同步，下一次截图后恢复'

/** What went wrong connecting, in the user's terms */
function describeRelayError(error: Error & { code?: string }): string {
  const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1]
  if (status) return `服务器拒绝连接（HTTP ${status}），地址是否指向中转服务？`
  if (error.code === 'ECONNREFUSED') return '连不上服务器：端口没开放，或中转服务没在运行'
  if (error.code === 'ENOTFOUND') return '找不到服务器，检查地址'
  if (error.code === 'ETIMEDOUT' || /timed out/i.test(error.message)) {
    return '连接超时：检查服务器防火墙 / 安全组是否放行端口'
  }
  return error.message
}

/** Keep a host connection to the relay at `base`, reconnecting until closed */
function connectRelay(id: string, base: URL, key: string): RelayClient {
  const hostURL = new URL('host', base)
  hostURL.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  let socket: WebSocket | null = null
  let closed = false
  let retryDelay = 1000
  let retryTimer: NodeJS.Timeout | null = null
  let silenceTimer: NodeJS.Timeout | null = null

  const set = (patch: Partial<MobileSyncStatus['relay']>) => {
    if (closed) return
    Object.assign(status.relay, patch)
    noteViewers()
  }

  /**
   * A frame the relay would refuse is not sent: it would close the connection
   * with 1009, and the reconnect would send it again. TOO_LARGE stays up
   * until a frame fits again
   */
  function sendState(ws: WebSocket, data: MobileState) {
    const frame = JSON.stringify({ type: 'state', data })
    if (Buffer.byteLength(frame) > MAX_PAYLOAD) {
      set({ error: TOO_LARGE })
      return
    }
    if (status.relay.error === TOO_LARGE) set({ error: undefined })
    ws.send(frame)
  }

  function open() {
    set({ state: 'starting' })
    const ws = new WebSocket(hostURL, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 10_000
    })
    socket = ws
    // No ping for too long: the connection died without telling anyone
    const heard = () => {
      if (silenceTimer) clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => ws.terminate(), RELAY_SILENCE_LIMIT)
    }
    let refused = ''

    ws.on('open', () => {
      retryDelay = 1000
      set({ state: 'on', error: undefined })
      heard()
      sendState(ws, buildState())
    })
    ws.on('ping', heard)
    ws.on('message', (raw) => {
      heard()
      try {
        const message = JSON.parse(raw.toString())
        if (message?.type === 'viewers') {
          set({ viewers: Number(message.count) || 0, maxViewers: Number(message.max) || undefined })
        }
      } catch {
        // not ours
      }
    })
    ws.on('error', (error) => {
      // 401: the key is wrong, and trying again will not make it right
      if (/Unexpected server response: 401/.test(error.message)) {
        refused = '密钥与服务器上的 RELAY_KEY 不一致'
      } else {
        set({ error: describeRelayError(error) })
      }
    })
    ws.on('close', (code) => {
      if (silenceTimer) clearTimeout(silenceTimer)
      if (socket === ws) socket = null
      if (closed) return
      set({ viewers: 0 })
      if (refused || code === 4000) {
        // 4000: another app took over with the same key; reconnecting would
        // only take it back and start a tug of war
        set({ state: 'error', error: refused || '同一密钥已在另一台电脑上连接，本机已停止同步' })
        return
      }
      // 1009: a server with a lower limit than ours; the next state may fit
      set({ state: 'error', ...(code === 1009 && { error: TOO_LARGE }) })
      retryTimer = setTimeout(open, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RELAY_RETRY_MAX)
    })
  }

  open()
  return {
    id,
    send: (data) => {
      if (socket?.readyState === WebSocket.OPEN) sendState(socket, data)
    },
    close: () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (silenceTimer) clearTimeout(silenceTimer)
      socket?.terminate()
    }
  }
}

/** The relay to connect to, or why the settings do not make one */
function relayTarget(): { base: URL; key: string } | { error: string } {
  const input = settings.mobileRelayURL.trim()
  if (!input) return { error: '请填写服务器地址' }
  let base: URL
  try {
    base = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`)
  } catch {
    return { error: '服务器地址格式不对，例如 http://1.2.3.4:8787' }
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  base.search = ''
  base.hash = ''
  const key = settings.mobileRelayKey.trim()
  if (key.length < 16) return { error: '密钥至少 16 位，与服务器的 RELAY_KEY 相同' }
  return { base, key }
}

function reconcileRelay() {
  const target = settings.mobileRelayEnabled ? relayTarget() : null
  const id = target && 'base' in target ? `${target.base.href}\n${target.key}` : ''
  if (remote && remote.id === id) return
  remote?.close()
  remote = null
  if (!target) {
    status.relay = { state: 'off', url: '', viewers: 0 }
    return
  }
  if ('error' in target) {
    status.relay = { state: 'error', url: '', viewers: 0, error: target.error }
    return
  }
  status.relay = {
    state: 'starting',
    url: `${target.base.href}#t=${deriveViewerToken(target.key)}`,
    viewers: 0
  }
  remote = connectRelay(id, target.base, target.key)
}

// ---- Settings ----

function reconcile() {
  const lanKey = settings.mobileLanEnabled ? settings.mobileLanKey : ''
  if (lan && lan.key !== lanKey) stopLan()
  // A failed start is tried again with the next settings change
  if (lanKey && !lan) startLan(lanKey)
  reconcileRelay()
  // Switching a path off drops its phones
  noteViewers()
}

let reconcileTimer: NodeJS.Timeout | null = null
onSettingsChanged(() => {
  if (reconcileTimer) clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(reconcile, RECONCILE_DELAY)
})

ipcMain.handle('mobile:get-status', () => getStatus())
