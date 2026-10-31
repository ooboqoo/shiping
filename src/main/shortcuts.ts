import { app, globalShortcut, ipcMain, screen } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ModelMessage } from 'ai'
import { applyContentProtection } from './window-privacy'
import {
  showToolbar,
  hideToolbar,
  setToolbarWanted,
  reassertToolbarTopMost,
  sendToToolbar
} from './toolbar-window'
import { takeScreenshot } from './take-screenshot'
import { pickCaptureRegion, pickScreenshot } from './region-picker'
import type { CaptureRegion } from '../shared/capture-region'
import { saveScreenshotToDisk } from './save-screenshot'
import { handleGeneratedCode } from './save-code'
import { getSolutionStream, getFollowUpStream, getGeneralStream } from './ai'
import { state, setPageChangeHandler, inModePage } from './state'
import { settings, getModeProfile, onSettingsChanged } from './settings'
import { getTranscriptionText, clearTranscriptionText } from './transcription'
import { consumeStream, extractErrorMessage, isImageInputRefused } from './stream'
import type { StreamChunk } from './stream'
import { requestHint, stopHints, clearConversation } from './conversation'
import {
  hasMobileViewers,
  markMobileDirty,
  onMobileViewersChanged,
  pageMobile,
  registerMobileSource
} from './mobile-sync'
import type { MobileAnswer } from '../shared/mobile'

/**
 * `registered`: the key is held now. `available`: free, but not held, the
 * action having nothing to do at the moment (see `isShortcutLive`) or no key.
 * `failed`: another app holds the key, so pressing it never reaches this one
 */
type ShortcutStatus = 'registered' | 'failed' | 'available'

export type Shortcut = {
  action: string
  /** Empty when the user cleared it: the action then has no key */
  key: string
  status: ShortcutStatus
  registeredKeys: string[]
}

const MOVE_STEP = 200
/** Opacity delta per shortcut press, matching the settings slider step */
const OPACITY_STEP = 0.05
const shortcuts: Record<string, Shortcut> = {}

/**
 * Windows repeats a held global shortcut at the keyboard's auto-repeat rate:
 * Chromium registers it without MOD_NOREPEAT, and the callback cannot tell a
 * repeat from a press. So a press within KEY_REPEAT_GAP of the previous one is
 * taken as a repeat and dropped, and it extends the gap: holding the keys, or a
 * key stuck down, fires the action once. The gap outlasts Windows' default
 * 500ms delay before the first repeat. Only actions that step something repeat.
 */
const KEY_REPEAT_GAP = 600
const REPEATABLE_ACTIONS = new Set([
  'moveMainWindowUp',
  'moveMainWindowDown',
  'moveMainWindowLeft',
  'moveMainWindowRight',
  'pageUp',
  'pageDown',
  'increaseOpacity',
  'decreaseOpacity'
])
const lastShortcutAt: Record<string, number> = {}

function isKeyRepeat(action: string): boolean {
  if (REPEATABLE_ACTIONS.has(action)) return false
  const now = performance.now()
  const last = lastShortcutAt[action]
  lastShortcutAt[action] = now
  return last !== undefined && now - last < KEY_REPEAT_GAP
}

type AbortReason = 'user' | 'new-request'

interface StreamContext {
  controller: AbortController
  reason: AbortReason | null
}

let currentStreamContext: StreamContext | null = null
/**
 * Bumped by every screenshot request and by stop. A capture takes up to a
 * second and Electron hands every request made meanwhile the same capture, so
 * only the newest request, if not stopped, goes on to ask the AI.
 */
let screenshotRequestId = 0

// Conversation history tracking
let conversationMessages: ModelMessage[] = []
let recentScreenshots: string[] = [] // 最近截图，水平预览 (限5张)
/** Every screenshot in the current conversation, including the ones dropped from the preview */
let screenshotCount = 0
let hasAppendSeparator = false

/** The answer as the phones see it: the same text the page accumulates from the chunks */
const mobileAnswer: MobileAnswer = { id: 0, status: 'idle', text: '', screenshots: 0 }
registerMobileSource('screenshot', () => ({ ...mobileAnswer }))

function updateMobileAnswer(patch: Partial<MobileAnswer>) {
  Object.assign(mobileAnswer, patch)
  markMobileDirty()
}

/** Part of the answer, for the page and the phones alike */
function sendAnswerChunk(mainWindow: BrowserWindow, text: string) {
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send('solution-chunk', text)
  updateMobileAnswer({ text: mobileAnswer.text + text })
}

const FRONT_REASSERT_DURATION = 8000
const FRONT_REASSERT_INTERVAL = 100
const FRONT_RELATIVE_LEVEL = 100
const BACKGROUND_GUARD_INTERVAL = 2000
let frontReassertTimer: NodeJS.Timeout | null = null
let backgroundGuardTimer: NodeJS.Timeout | null = null
let isWindowSoftHidden = false
let softHiddenPosition: [number, number] | null = null

/**
 * The window is up because 框选识别 showed its answer, and still has the
 * keyboard. The pick took it from the app the user was in, so the window keeps
 * it: Esc hides the window (the page shows it as Esc 隐藏窗口), and hiding
 * hands the keyboard back. It ends the moment the window loses the keyboard or
 * is hidden, so Esc never hides a window the user is not looking at. Any other
 * way the window is shown keeps the overlay's rule of never taking focus, and
 * leaves Esc alone
 */
let snipSession = false

function setSnipSession(active: boolean): void {
  if (snipSession === active) return
  snipSession = active
  const mainWindow = global.mainWindow
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('snip-session', active)
}

/**
 * Give the keyboard back to the app the user was in, after hiding a window
 * that had it (`hadFocus`, read before hiding: a hidden window is never
 * focused). A window without it changes nothing: the app in front keeps it.
 * macOS hands it back when the app hides, the window being hidden already.
 * Windows' blur() hands the foreground to the next visible window in z-order,
 * which for a top-most window is the taskbar, so the window, parked
 * off-screen, first leaves the top-most band; showing it again re-raises it
 */
function returnFocus(window: BrowserWindow, hadFocus: boolean): void {
  if (!hadFocus || window.isDestroyed()) return
  if (process.platform === 'darwin') {
    app.hide()
    return
  }
  window.setAlwaysOnTop(false)
  window.blur()
}

/**
 * Reassert always-on-top. `aggressive` also calls moveTop() which
 * brings the window above everything — only use on explicit user actions
 * (show, screenshot, etc.) to avoid disturbing interaction with other apps.
 */
function applyTopMost(win: BrowserWindow, aggressive = true) {
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, 'screen-saver', FRONT_RELATIVE_LEVEL)
  if (aggressive) win.moveTop()

  if (state.ignoreMouse) {
    reassertToolbarTopMost(FRONT_RELATIVE_LEVEL + 1, aggressive)
  }
}

/**
 * Start a persistent low-frequency background guard that continuously
 * re-asserts always-on-top while the window is visible.
 * Uses the non-aggressive variant so it won't steal focus or
 * interfere with the user's interaction with other windows.
 */
function startBackgroundGuard(window: BrowserWindow) {
  if (backgroundGuardTimer) return // already running
  backgroundGuardTimer = setInterval(() => {
    if (!window || window.isDestroyed() || !window.isVisible()) {
      stopBackgroundGuard()
      return
    }
    applyTopMost(window, false)
  }, BACKGROUND_GUARD_INTERVAL)
}

function stopBackgroundGuard() {
  if (backgroundGuardTimer) {
    clearInterval(backgroundGuardTimer)
    backgroundGuardTimer = null
  }
}

function stopFrontReassert() {
  if (frontReassertTimer) {
    clearInterval(frontReassertTimer)
    frontReassertTimer = null
  }
}

/**
 * Soft-hide parks the window here and puts it back by position alone. Its size
 * is never read and rewritten: on Windows the DIP <-> pixel conversion encloses
 * in both directions, so every such round trip would hand back a slightly
 * larger window (see toolbar-window.ts).
 */
function getOffscreenPosition(): [number, number] {
  const displays = screen.getAllDisplays()
  const maxRight = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const topMost = Math.min(...displays.map((display) => display.bounds.y))

  return [maxRight + 2000, topMost]
}

function softHideWindow(window: BrowserWindow) {
  if (isWindowSoftHidden || window.isDestroyed()) return

  stopFrontReassert()
  stopBackgroundGuard()
  softHiddenPosition = window.getPosition() as [number, number]
  isWindowSoftHidden = true

  window.setOpacity(0)
  window.setIgnoreMouseEvents(true)
  window.setPosition(...getOffscreenPosition())
  hideToolbar()
  syncShortcuts()
}

function restoreSoftHiddenWindow(window: BrowserWindow) {
  if (!isWindowSoftHidden || !softHiddenPosition || window.isDestroyed()) return

  applyContentProtection(window, true)
  window.setPosition(...softHiddenPosition)
  window.setOpacity(1)

  isWindowSoftHidden = false
  softHiddenPosition = null
  // Not the raw preference: it stays suspended if this is the settings page
  applyIgnoreMouse()
  showToolbar()
  keepWindowInFront(window)
  syncShortcuts()
}

function showMainWindow(window: BrowserWindow) {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    window.showInactive()
  } else {
    window.show()
  }

  applyContentProtection(window, process.platform === 'win32')
  showToolbar()
  keepWindowInFront(window)
  syncShortcuts()
}

/** Undo `hideOrShowMainWindow`'s hiding, whichever way it hid the window */
export function revealMainWindow(window: BrowserWindow) {
  if (isWindowSoftHidden) restoreSoftHiddenWindow(window)
  else if (!window.isVisible()) showMainWindow(window)
}

/** On screen: neither hidden nor parked off-screen by soft-hide, which still counts as visible */
export function isMainWindowShown(): boolean {
  const mainWindow = global.mainWindow
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !isWindowSoftHidden
}

function keepWindowInFront(window: BrowserWindow) {
  if (!window || window.isDestroyed()) return
  if (frontReassertTimer) {
    clearInterval(frontReassertTimer)
    frontReassertTimer = null
  }

  const start = Date.now()
  const reassert = () => {
    if (!window.isVisible() || window.isDestroyed()) return false
    applyTopMost(window)
    return true
  }

  if (!reassert()) return

  // Aggressive burst: rapid reasserts for a short period
  frontReassertTimer = setInterval(() => {
    const shouldStop = Date.now() - start > FRONT_REASSERT_DURATION
    if (shouldStop || !reassert()) {
      if (frontReassertTimer) {
        clearInterval(frontReassertTimer)
        frontReassertTimer = null
      }
    }
  }, FRONT_REASSERT_INTERVAL)

  // Ensure background guard is running for persistent protection
  startBackgroundGuard(window)
}

/**
 * Opacity is owned by the renderer settings store (persisted + synced back to
 * main), so the shortcut only asks the renderer to step it.
 */
function adjustOpacity(delta: number) {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
  mainWindow.webContents.send('adjust-opacity', delta)
}

function abortCurrentStream(reason: AbortReason) {
  if (!currentStreamContext) return
  currentStreamContext.reason = reason
  currentStreamContext.controller.abort()
}

/**
 * Start tracking a new answer, replacing whatever streams now. Called right
 * before streaming, after any awaited capture: a stream started during the
 * capture would otherwise go untracked, out of reach of later requests and of
 * the stop key, and write into the same answer.
 */
function beginStream(): StreamContext {
  abortCurrentStream('new-request')
  const streamContext: StreamContext = { controller: new AbortController(), reason: null }
  currentStreamContext = streamContext
  return streamContext
}

/** Stop the answer, and drop a screenshot still being captured for a new one */
function stopAnswer(): boolean {
  screenshotRequestId++
  if (!currentStreamContext) return false
  abortCurrentStream('user')
  return true
}

/**
 * Hand the stored click-through state to the window.
 *
 * It stays off while the settings page is on screen even when the user asked
 * for it: the switch that turns it back off lives on that page, so applying it
 * there would swallow the clicks needed to undo it. The preference is kept, and
 * takes effect the moment the user leaves the page.
 */
function applyIgnoreMouse(): void {
  const mainWindow = global.mainWindow
  // A soft-hidden window ignores the mouse regardless; it is reapplied on restore
  if (!mainWindow || mainWindow.isDestroyed() || isWindowSoftHidden) return
  mainWindow.setIgnoreMouseEvents(state.ignoreMouse && !state.inSettingsPage)
}

/**
 * Explain why a request was not sent. The welcome dialog used to cover a blank
 * key, but it now shows only once, so switching to a profile without a key
 * would otherwise leave the shortcut doing nothing at all.
 */
function reportMissingApiKey(mainWindow: BrowserWindow): void {
  const message = '截图模式使用的 AI 配置未填写 API Key，请到「设置 → AI 模型」填写'
  mainWindow.webContents.send('solution-error', message)
  updateMobileAnswer({ status: 'error', error: message })
}

/** The profile screenshots go out with, or null (after reporting it) when it has no key */
function screenshotProfileReady(mainWindow: BrowserWindow): boolean {
  if (getModeProfile('screenshot').apiKey) return true
  reportMissingApiKey(mainWindow)
  return false
}

/** Tell both renderers what the window is actually doing */
function broadcastAppState(): void {
  const mainWindow = global.mainWindow
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-app-state', state)
  }
  // The toolbar is a separate renderer with its own store, so it needs its own
  // copy; without this its button keeps showing the state it last saw
  sendToToolbar('sync-app-state', state)
}

/**
 * Turn click-through on or off. Independent of the overlay toolbar: the
 * toolbar is one way to operate the window, not a requirement, so hiding it
 * leaves this working — the settings page and the shortcut can both drive it.
 */
export function setIgnoreMouse(ignore: boolean): void {
  state.ignoreMouse = ignore
  applyIgnoreMouse()
  // Keep the toolbar visible if it is wanted, so its button stays reachable;
  // a soft-hidden window still counts as visible, so check that separately
  if (!isWindowSoftHidden) showToolbar()
  broadcastAppState()
}

// Leaving or entering the settings page changes whether the stored preference
// may be applied, so re-run it on every page change
setPageChangeHandler(() => {
  // Esc 隐藏窗口 lives on 截图模式's page; leaving it ends what it was offered for
  setSnipSession(false)
  applyIgnoreMouse()
  broadcastAppState()
  // The phones follow the mode on screen
  markMobileDirty()
  // The page decides which actions have anything to do
  syncShortcuts()
})

/**
 * When the current request started, or null when none is running.
 *
 * Timing is done here rather than in the renderer: the renderer's timers are
 * throttled while the window is hidden or the display is asleep, which is
 * exactly when this app is most likely to be waiting on a long answer.
 */
let requestStartedAt: number | null = null

/** Start timing a request; called the moment the user presses the shortcut */
function startTiming() {
  requestStartedAt = Date.now()
}

/**
 * Report how long the request took, in milliseconds. Called from every
 * terminal path (finished, stopped, failed) so no outcome is left untimed.
 */
function reportDuration() {
  if (requestStartedAt === null) return
  const elapsed = Date.now() - requestStartedAt
  requestStartedAt = null
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('solution-duration', elapsed)
}

/**
 * Keep the main window out of the way while the user drags on the region
 * picker: it would cover part of the screen, and the top-most guard would keep
 * lifting it back above the picker. A window that was already soft-hidden, by
 * the user or by a pick in progress, is left for whoever hid it to bring back.
 */
async function whilePicking<T>(mainWindow: BrowserWindow, pick: () => Promise<T>): Promise<T> {
  const wasHidden = isWindowSoftHidden
  softHideWindow(mainWindow)
  try {
    return await pick()
  } finally {
    if (!wasHidden) restoreSoftHiddenWindow(mainWindow)
  }
}

/**
 * Let the user drag out a new capture region, from the settings page, the
 * toolbar or the shortcut. The result applies here at once, and goes to the
 * renderer too, whose store is what persists it.
 */
async function pickRegion(): Promise<CaptureRegion | null> {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const region = await whilePicking(mainWindow, () => pickCaptureRegion(settings.captureRegion))
  if (region) {
    settings.captureRegion = region
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('capture-region-picked', region)
  }
  return region
}

/**
 * Why a screenshot request failed, in the user's terms. A model that takes no
 * images is the likeliest mistake since profiles are shared with 对话模式, so
 * it is named outright, and the renderer marks the profile as text-only.
 */
function describeAnswerError(mainWindow: BrowserWindow, error: unknown): string {
  const message = extractErrorMessage(error)
  if (!isImageInputRefused(error)) return message
  const profile = getModeProfile('screenshot')
  if (profile.id) mainWindow.webContents.send('vision-unsupported', profile.id)
  return `「${profile.name || profile.model}」的模型不支持图片输入，请到「设置 → 截图模式」换一个能识图的 AI 配置（${message}）`
}

/**
 * Stream an answer onto the main page: reasoning chunks as `reasoning-chunk`,
 * answer chunks as `solution-chunk`, then `solution-complete`,
 * `solution-stopped` (stopped by the user) or `solution-error`. A stream
 * replaced by a newer request ends silently.
 * `onComplete` gets the whole answer, only when it finished on its own.
 */
async function runAnswer(
  mainWindow: BrowserWindow,
  streamContext: StreamContext,
  createStream: (signal: AbortSignal) => AsyncIterable<StreamChunk>,
  onComplete: (answer: string) => void,
  { showLoading }: { showLoading: boolean }
): Promise<void> {
  const send = (channel: string, ...args: unknown[]) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
  }
  if (showLoading) send('ai-loading-start')
  updateMobileAnswer({ status: 'streaming', error: undefined })
  try {
    const outcome = await consumeStream(createStream, streamContext.controller, (chunk) => {
      if (chunk.kind === 'reasoning') send('reasoning-chunk', chunk.delta)
      else sendAnswerChunk(mainWindow, chunk.delta)
    })
    if (outcome.status === 'aborted') {
      // Replaced by a newer request, which has set the status already
      if (streamContext.reason === 'user') {
        send('solution-stopped')
        updateMobileAnswer({ status: 'stopped' })
      }
    } else if (outcome.status === 'failed') {
      console.error('Error streaming solution:', outcome.error)
      if (!mainWindow.isDestroyed()) {
        const message = describeAnswerError(mainWindow, outcome.error)
        send('solution-error', message)
        updateMobileAnswer({ status: 'error', error: message })
      }
    } else {
      onComplete(outcome.text)
      send('solution-complete')
      updateMobileAnswer({ status: 'done' })
    }
  } finally {
    if (currentStreamContext === streamContext) {
      currentStreamContext = null
    }
    // A stream aborted by a newer request must not report: the new request
    // has already restarted the timer, and reporting here would cut it short
    if (streamContext.reason !== 'new-request') {
      reportDuration()
    }
    if (showLoading) send('ai-loading-end')
  }
}

/** Ask the renderer to show the other mode; it owns the routes */
function switchMode() {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
  mainWindow.webContents.send('switch-mode')
}

/** Start a new conversation from one screenshot, with the transcription text not yet sent */
async function startScreenshotConversation(mainWindow: BrowserWindow, screenshotData: string) {
  saveScreenshotToDisk(screenshotData)
  const transcriptionText = getTranscriptionText()
  if (transcriptionText) {
    clearTranscriptionText()
    mainWindow.webContents.send('transcription-cleared')
  }
  conversationMessages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: transcriptionText
            ? `这是语音转录内容：\n${transcriptionText}\n\n同时附上屏幕截图：`
            : '这是屏幕截图'
        },
        {
          type: 'image',
          image: screenshotData
        }
      ]
    }
  ]

  const streamContext = beginStream()
  recentScreenshots = [screenshotData]
  screenshotCount = 1
  hasAppendSeparator = false
  mainWindow.webContents.send('solution-clear')
  updateMobileAnswer({ id: mobileAnswer.id + 1, text: '', screenshots: screenshotCount })
  mainWindow.webContents.send('screenshots-updated', recentScreenshots, screenshotCount)
  mainWindow.webContents.send('screenshot-taken', screenshotData)
  await runAnswer(
    mainWindow,
    streamContext,
    (signal) => getSolutionStream(conversationMessages, signal),
    (answer) => {
      if (!answer) return
      conversationMessages.push({ role: 'assistant', content: answer })
      // 答案已经写完，才处理代码（中途停止或报错不会走到这里）
      handleGeneratedCode(answer)
    },
    { showLoading: true }
  )
}

/**
 * Hide the main window the way `hideOrShowMainWindow` does, from any of its
 * entry points (shortcut, tray menu, the header's 隐藏 button, Esc after 框选识别)
 */
export function hideMainWindow(): void {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
  setSnipSession(false)
  const hadFocus = mainWindow.isFocused()
  if (process.platform === 'win32') {
    softHideWindow(mainWindow)
  } else {
    stopBackgroundGuard()
    mainWindow.hide()
  }
  returnFocus(mainWindow, hadFocus)
  syncShortcuts()
}

// The header's 隐藏 button, and Esc after 框选识别
ipcMain.handle('hideMainWindow', () => hideMainWindow())

/** End the 框选识别 session once the user moves on, see `snipSession` */
export function watchMainWindowFocus(window: BrowserWindow): void {
  window.on('blur', () => setSnipSession(false))
}

const callbacks: Record<string, () => void> = {
  hideOrShowMainWindow: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    if (process.platform === 'win32') {
      if (isWindowSoftHidden) {
        restoreSoftHiddenWindow(mainWindow)
        return
      }

      if (!mainWindow.isVisible()) {
        showMainWindow(mainWindow)
        return
      }

      hideMainWindow()
      return
    }

    if (mainWindow.isVisible()) {
      hideMainWindow()
    } else {
      // 重新显示时不断重申置顶属性，抵消其他前台软件持续抢占
      showMainWindow(mainWindow)
    }
  },

  takeScreenshot: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    if (!screenshotProfileReady(mainWindow)) return

    abortCurrentStream('new-request')
    // Timing covers the whole wait the user experiences: capture + request + render
    startTiming()
    const requestId = ++screenshotRequestId
    const screenshotData = await takeScreenshot()
    // Overtaken by a newer screenshot, or stopped, while capturing
    if (requestId !== screenshotRequestId) return
    if (!screenshotData || mainWindow.isDestroyed()) return
    await startScreenshotConversation(mainWindow, screenshotData)
  },

  /**
   * Drag out an area and get an answer about just that, leaving the capture
   * region alone: the screenshot-tool way, with the window kept hidden until
   * needed. So the answer is shown even if the window was hidden; a cancelled
   * pick leaves the window as it was.
   */
  snipScreenshot: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    if (!screenshotProfileReady(mainWindow)) return

    const screenshotData = await whilePicking(mainWindow, pickScreenshot)
    if (!screenshotData || mainWindow.isDestroyed()) return
    revealMainWindow(mainWindow)
    // The picker had the keyboard; the window takes it over, for Esc
    mainWindow.focus()
    setSnipSession(true)
    // The wait starts when the drag ends, not while the user is still picking
    startTiming()
    // A screenshot still being captured from before the drag ended loses to this one
    screenshotRequestId++
    await startScreenshotConversation(mainWindow, screenshotData)
  },

  // Append screenshot for continuous capture (if conversation exists)
  appendScreenshot: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) return
    if (!screenshotProfileReady(mainWindow)) return

    // Fallback to first screenshot if no conversation
    if (conversationMessages.length === 0) {
      callbacks.takeScreenshot()
      return
    }

    abortCurrentStream('new-request')
    startTiming()

    const requestId = ++screenshotRequestId
    const screenshotData = await takeScreenshot()
    // Overtaken by a newer screenshot, or stopped, while capturing
    if (requestId !== screenshotRequestId) return
    if (!screenshotData || mainWindow.isDestroyed()) return

    saveScreenshotToDisk(screenshotData)
    const transcriptionText = getTranscriptionText()
    if (transcriptionText) {
      clearTranscriptionText()
      mainWindow.webContents.send('transcription-cleared')
    }
    // Append new image message to conversation
    conversationMessages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: transcriptionText
            ? `这是下一部分截图和语音转录内容：\n${transcriptionText}\n请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。`
            : '这是下一部分截图，请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。'
        },
        {
          type: 'image',
          image: screenshotData
        }
      ]
    })

    const streamContext = beginStream()

    recentScreenshots.push(screenshotData)
    recentScreenshots = recentScreenshots.slice(-5) // 限5张
    screenshotCount += 1
    mainWindow.webContents.send('screenshot-taken', screenshotData)
    mainWindow.webContents.send('screenshots-updated', recentScreenshots, screenshotCount)
    updateMobileAnswer({ screenshots: screenshotCount })
    if (!hasAppendSeparator) {
      sendAnswerChunk(mainWindow, '\n\n---\n\n')
      hasAppendSeparator = true
    } else {
      sendAnswerChunk(mainWindow, '\n\n')
    }
    // The appended screenshot gets its own reasoning, shown in its own block
    mainWindow.webContents.send('reasoning-round-start')
    await runAnswer(
      mainWindow,
      streamContext,
      (signal) => getGeneralStream(conversationMessages, signal),
      (answer) => {
        if (!answer) return
        conversationMessages.push({ role: 'assistant', content: answer })
        // 答案已经写完，才处理代码（中途停止或报错不会走到这里）
        handleGeneratedCode(answer)
      },
      { showLoading: true }
    )
  },

  // Stop current AI solution stream, or 对话模式's hints
  stopSolutionStream: () => {
    if (state.inConversationPage) stopHints()
    else stopAnswer()
  },

  /**
   * Ask the renderer to step the current mode through the saved AI profiles.
   * The list lives in the renderer store (persisted there), so main only
   * relays the direction.
   */
  nextApiProfile: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
    mainWindow.webContents.send('switch-api-profile', 1)
  },

  previousApiProfile: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
    mainWindow.webContents.send('switch-api-profile', -1)
  },

  /**
   * The scenes live in the renderer store, so main only asks it to step; the
   * new prompt comes back as `customPrompt` and is read at the next request.
   * The conversation is kept: a new screenshot starts a new one anyway, and a
   * follow-up after switching needs the question it follows up on.
   */
  cycleScene: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
    mainWindow.webContents.send('cycle-scene')
  },

  ignoreOrEnableMouse: () => {
    setIgnoreMouse(!state.ignoreMouse)
  },

  increaseOpacity: () => {
    adjustOpacity(OPACITY_STEP)
  },

  decreaseOpacity: () => {
    adjustOpacity(-OPACITY_STEP)
  },

  pageUp: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
    mainWindow.webContents.send('scroll-page-up')
    pageMobile(-1)
  },

  pageDown: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
    mainWindow.webContents.send('scroll-page-down')
    pageMobile(1)
  },

  moveMainWindowUp: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x, y - MOVE_STEP)
  },

  moveMainWindowDown: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x, y + MOVE_STEP)
  },

  moveMainWindowLeft: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x - MOVE_STEP, y)
  },

  moveMainWindowRight: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x + MOVE_STEP, y)
  },

  toggleTranscription: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !inModePage()) return
    mainWindow.webContents.send('toggle-transcription')
  },

  // 对话模式 starts the conversation over; 截图模式 drops the text not yet sent
  clearTranscription: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (state.inConversationPage) {
      clearConversation()
      return
    }
    if (!state.inCoderPage) return
    clearTranscriptionText()
    mainWindow.webContents.send('transcription-cleared')
  },

  // 对话模式: a hint now, whatever the automatic mode is waiting for
  generateHint: () => {
    if (state.inConversationPage) requestHint()
  },

  // 对话模式: the renderer owns the setting, main reads it back on the next sentence
  toggleHintMode: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || !state.inConversationPage) return
    mainWindow.webContents.send('toggle-hint-mode')
  },

  switchMode,

  // Works on every page: it only sets up future screenshots
  pickCaptureRegion: () => {
    void pickRegion()
  }
}

/** The tray icon runs these as if their shortcut had been pressed */
export function runShortcutAction(action: 'snipScreenshot' | 'hideOrShowMainWindow'): void {
  callbacks[action]()
}

const clickableActions = new Set([
  'takeScreenshot',
  'appendScreenshot',
  'stopSolutionStream',
  'ignoreOrEnableMouse',
  'increaseOpacity',
  'decreaseOpacity',
  'pageUp',
  'pageDown',
  'moveMainWindowUp',
  'moveMainWindowDown',
  'moveMainWindowLeft',
  'moveMainWindowRight',
  'toggleTranscription',
  'clearTranscription',
  'pickCaptureRegion',
  'cycleScene',
  'generateHint',
  'toggleHintMode',
  'switchMode'
])

type ShortcutPage = 'any' | 'mode' | 'screenshot' | 'conversation'

/**
 * When an action has something to do, which is when its key is held (see
 * `isShortcutLive`). `page`: the pages its callback acts on. `hidden`: it is
 * also there to be used while the window is hidden. `window`: it acts on the
 * window itself, so it never outlives the window being shown. `voice`: it
 * needs the DashScope key. A new action needs an entry here too
 */
const SHORTCUT_SCOPES: Record<
  string,
  { page: ShortcutPage; hidden?: true; window?: true; voice?: true }
> = {
  hideOrShowMainWindow: { page: 'any', hidden: true },
  switchMode: { page: 'mode' },
  ignoreOrEnableMouse: { page: 'any', window: true },
  increaseOpacity: { page: 'mode', window: true },
  decreaseOpacity: { page: 'mode', window: true },
  takeScreenshot: { page: 'screenshot' },
  snipScreenshot: { page: 'screenshot', hidden: true },
  appendScreenshot: { page: 'screenshot' },
  pickCaptureRegion: { page: 'any' },
  generateHint: { page: 'conversation' },
  toggleHintMode: { page: 'conversation' },
  stopSolutionStream: { page: 'any' },
  previousApiProfile: { page: 'mode' },
  nextApiProfile: { page: 'mode' },
  cycleScene: { page: 'mode' },
  toggleTranscription: { page: 'mode', voice: true },
  clearTranscription: { page: 'mode', voice: true },
  pageUp: { page: 'mode' },
  pageDown: { page: 'mode' },
  moveMainWindowUp: { page: 'any', window: true },
  moveMainWindowDown: { page: 'any', window: true },
  moveMainWindowLeft: { page: 'any', window: true },
  moveMainWindowRight: { page: 'any', window: true }
}

function onShortcutPage(page: ShortcutPage): boolean {
  if (page === 'screenshot') return state.inCoderPage
  if (page === 'conversation') return state.inConversationPage
  return page === 'any' || inModePage()
}

/**
 * The settings page is recording a key. None is held meanwhile: a press of a
 * held one would run its action instead of reaching the page
 */
let recordingShortcut = false

/**
 * Whether an action's key is held now. A held key never reaches the app in
 * front, so each is held only while its action has something to do: on its
 * own page, and with the window shown. Hidden, the app lives in the background
 * and keeps only the keys meant for that (show it again, 框选识别), unless
 * phones are watching (手机同步): their screen stands in for the window, so
 * the actions that do not act on the window itself stay
 */
function isShortcutLive(action: string): boolean {
  const scope = SHORTCUT_SCOPES[action] ?? { page: 'any' }
  if (recordingShortcut && state.inSettingsPage) return false
  if (scope.voice && !settings.dashscopeApiKey) return false
  if (!onShortcutPage(scope.page)) return false
  if (scope.hidden || isMainWindowShown()) return true
  return !scope.window && hasMobileViewers()
}

function releaseShortcut(shortcut: Shortcut) {
  shortcut.registeredKeys.forEach((registeredKey) => {
    globalShortcut.unregister(registeredKey)
  })
  shortcut.registeredKeys = []
  shortcut.status = 'available'
}

function getShortcutRegistrationKeys(key: string) {
  const keys = [key]
  if (process.platform !== 'win32') {
    return keys
  }
  const parts = key.split('+')
  const hasAlt = parts.includes('Alt')
  const hasCtrl = parts.includes('CommandOrControl') || parts.includes('Control')
  if (hasAlt && !hasCtrl) {
    const aliasParts = [...parts]
    const altIndex = aliasParts.indexOf('Alt')
    if (altIndex >= 0) {
      aliasParts.splice(altIndex, 0, 'CommandOrControl')
      const aliasKey = aliasParts.join('+')
      if (!keys.includes(aliasKey)) {
        keys.push(aliasKey)
      }
    }
  }
  return keys
}

/** Hold an action's key, if it is not held already */
function takeShortcut(shortcut: Shortcut) {
  if (shortcut.registeredKeys.length) return
  const onPress = () => {
    if (!isKeyRepeat(shortcut.action)) callbacks[shortcut.action]?.()
  }
  getShortcutRegistrationKeys(shortcut.key).forEach((shortcutKey) => {
    if (globalShortcut.register(shortcutKey, onPress)) {
      shortcut.registeredKeys.push(shortcutKey)
    }
  })
  shortcut.status = shortcut.registeredKeys.length ? 'registered' : 'failed'
}

/**
 * Hold the keys of the actions that are live now and release the others. Run
 * whenever what `isShortcutLive` reads changes, including by whoever shows or
 * hides the main window: its `show` / `hide` events cannot be relied on (they
 * did not fire on macOS). A key that failed is tried again each time: the app
 * holding it may have let it go
 */
export function syncShortcuts() {
  const all = Object.values(shortcuts)
  const live = (shortcut: Shortcut) => shortcut.key !== '' && isShortcutLive(shortcut.action)
  // Released first, so a key shared by two actions is free for the one now live
  all.filter((shortcut) => !live(shortcut)).forEach(releaseShortcut)
  all.filter(live).forEach(takeShortcut)
}

function bindShortcut(action: string, key: string) {
  if (shortcuts[action]) releaseShortcut(shortcuts[action])
  shortcuts[action] = { action, key, status: 'available', registeredKeys: [] }
}

/**
 * Whether `key` is taken elsewhere, for a key not held now: briefly taking it
 * is the only way to tell. Windows refuses a key another app holds. macOS lets
 * two apps hold the same one, so there it only catches the keys the system
 * keeps for itself. One held by another of this app's actions is not taken
 */
function heldElsewhere(key: string): boolean {
  if (globalShortcut.isRegistered(key)) return false
  if (!globalShortcut.register(key, () => {})) return true
  globalShortcut.unregister(key)
  return false
}

/** The key an action is bound to, for the tray menu to show; none if it did not register */
export function registeredShortcut(action: string): string | undefined {
  const shortcut = shortcuts[action]
  return shortcut?.status === 'registered' ? shortcut.key : undefined
}

// For the settings page, which warns of a key another app holds before it is ever needed
ipcMain.handle('getShortcuts', (): Record<string, Shortcut> => {
  return Object.fromEntries(
    Object.entries(shortcuts).map(([action, shortcut]) => {
      const untried = shortcut.status === 'available' && shortcut.key !== ''
      const status = untried && heldElsewhere(shortcut.key) ? 'failed' : shortcut.status
      return [action, { ...shortcut, status }]
    })
  )
})

ipcMain.handle(
  'initShortcuts',
  (_event, shortcuts: Record<string, { action: string; key: string }>) => {
    Object.entries(shortcuts).forEach(([action, { key }]) => {
      bindShortcut(action, key)
    })
    syncShortcuts()
  }
)

ipcMain.handle('updateShortcuts', (_event, _shortcuts: { action: string; key: string }[]) => {
  _shortcuts.forEach((shortcut) => {
    if (shortcuts[shortcut.action]?.key !== shortcut.key) {
      bindShortcut(shortcut.action, shortcut.key)
    }
  })
  syncShortcuts()
})

ipcMain.handle('setShortcutRecording', (_event, recording: boolean) => {
  recordingShortcut = recording
  syncShortcuts()
})

// The voice actions need the DashScope key
onSettingsChanged((previous) => {
  if (previous.dashscopeApiKey !== settings.dashscopeApiKey) syncShortcuts()
})

// Hidden, the window's place is taken by the phones watching, if any
onMobileViewersChanged(syncShortcuts)

ipcMain.handle('stopSolutionStream', () => stopAnswer())

ipcMain.handle('triggerAction', (_event, action: string) => {
  if (!clickableActions.has(action)) return false
  callbacks[action]?.()
  return true
})

ipcMain.handle('setToolbarVisible', (_event, visible: boolean) => {
  setToolbarWanted(visible)
})

/**
 * Set click-through from the settings page. A plain `set` rather than the
 * toolbar's toggle, so the switch always lands on the state the user picked.
 */
ipcMain.handle('setIgnoreMouse', (_event, ignore: boolean) => {
  setIgnoreMouse(ignore)
  return state.ignoreMouse
})

ipcMain.handle('pickCaptureRegion', () => pickRegion())

ipcMain.handle('sendFollowUpQuestion', async (_event, question: string) => {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || !state.inCoderPage) {
    return { success: false, error: 'Invalid state' }
  }
  if (!screenshotProfileReady(mainWindow)) {
    return { success: false, error: 'Missing API key' }
  }

  // Validate that there's an active conversation
  if (conversationMessages.length === 0) {
    return { success: false, error: 'No active conversation' }
  }

  startTiming()
  const streamContext = beginStream()

  // Add a separator before the follow-up response
  sendAnswerChunk(mainWindow, '\n\n---\n\n')
  // The follow-up gets its own reasoning, shown in its own block
  mainWindow.webContents.send('reasoning-round-start')

  await runAnswer(
    mainWindow,
    streamContext,
    (signal) => getFollowUpStream(conversationMessages, question, signal),
    (answer) => {
      // Update conversation history with user question and assistant response
      conversationMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: question
          }
        ]
      })
      if (answer) {
        conversationMessages.push({ role: 'assistant', content: answer })
        // 追问也可能给出完整解法，同样处理
        handleGeneratedCode(answer)
      }
    },
    { showLoading: false }
  )

  return { success: true }
})
