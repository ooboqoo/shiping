import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { applyContentProtection, registerStealthWindow } from './window-privacy'
import type { AppMode } from '../shared/api-profile'

/** What the bar's buttons depend on: which mode's buttons, and the microphone's icon */
export interface MiniBarState {
  /** The mode page the hidden main window is on, or was on last */
  mode: AppMode
  /** 对话模式 is listening to the other side */
  listening: boolean
  /** Listening ended by itself on an error, not by the user; cleared when it starts again */
  listenFailed: boolean
}

/** The grip and five buttons of `.overlay-toolbar`: 14px + 5 × 28px, 2px gaps, 8px padding each side */
const MINI_BAR_WIDTH = 180
const MINI_BAR_HEIGHT = 44
/** Above the main window (100) and the toolbar (101), below the region pickers */
const MINI_BAR_RELATIVE_LEVEL = 101
const TOP_MOST_GUARD_INTERVAL = 2000
/** Mirrors the renderer's default opacity setting, until the renderer syncs the real one */
const DEFAULT_OPACITY = 0.8

/** Created on first use, then kept for the session (see `attachMiniBar`) */
let miniBarWindow: BrowserWindow | null = null
/** Its page has painted: before that, showing it waits for `ready-to-show` */
let isMiniBarReady = false
/**
 * On screen as far as the rest of the app is concerned (shortcuts, picks),
 * including the moment before a newly created window has painted
 */
let isMiniBarShown = false
/** The main window; the bar is created only while it is open */
let ownerWindow: BrowserWindow | null = null
let miniBarOpacity = DEFAULT_OPACITY
/** Where the user left it this session; null until it is first shown */
let miniBarPosition: [number, number] | null = null
let topMostGuard: ReturnType<typeof setInterval> | null = null
const miniBarState: MiniBarState = { mode: 'screenshot', listening: false, listenFailed: false }

// The bar's renderer loads once and asks; every change after that is pushed
ipcMain.handle('mini-bar:get-state', () => miniBarState)

export function updateMiniBarState(next: Partial<MiniBarState>): void {
  const keys = Object.keys(next) as (keyof MiniBarState)[]
  if (keys.every((key) => next[key] === miniBarState[key])) return
  Object.assign(miniBarState, next)
  sendToMiniBar('mini-bar-state', miniBarState)
}

/**
 * 极简悬浮条: with the answer read on a phone, the screen needs nothing but the
 * screenshot buttons. Unlike the toolbar it is a window of its own, not glued
 * to the main window, since it is on screen exactly while that one is hidden.
 *
 * Like the toolbar, the window is a renderer of its own (about 40 MB), so it
 * is not created with the main window but the first time the bar is shown,
 * and kept from then on. Not a child window (it must stay up while the main
 * one is hidden), so it goes away with it by hand; left open it would keep the
 * app from quitting.
 */
export function attachMiniBar(mainWindow: BrowserWindow): void {
  ownerWindow = mainWindow
  mainWindow.on('closed', () => {
    ownerWindow = null
    if (miniBarWindow && !miniBarWindow.isDestroyed()) miniBarWindow.close()
  })
}

function ensureMiniBarWindow(): BrowserWindow | null {
  if (miniBarWindow && !miniBarWindow.isDestroyed()) return miniBarWindow
  if (!ownerWindow || ownerWindow.isDestroyed()) return null

  const window = new BrowserWindow({
    width: MINI_BAR_WIDTH,
    height: MINI_BAR_HEIGHT,
    title: '',
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    // Clicking a button must never pull focus away from the exam page (see toolbar-window.ts)
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    ...(process.platform === 'darwin' && { type: 'panel' }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Hover dwell runs on setTimeout in this renderer (see toolbar-window.ts)
      backgroundThrottling: false
    }
  })

  miniBarWindow = window
  isMiniBarReady = false

  window.setMenuBarVisibility(false)
  window.setOpacity(miniBarOpacity)
  window.setAlwaysOnTop(true, 'screen-saver', MINI_BAR_RELATIVE_LEVEL)
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })
  registerStealthWindow(window, '识屏 · 极简悬浮条')
  // Shown before its page painted: it appears now, unless hidden again meanwhile
  window.once('ready-to-show', () => {
    isMiniBarReady = true
    if (isMiniBarShown) presentMiniBar(window)
  })
  window.on('closed', () => {
    if (miniBarWindow !== window) return
    stopTopMostGuard()
    miniBarWindow = null
    isMiniBarReady = false
    isMiniBarShown = false
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/mini-bar`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/mini-bar' })
  }
  return window
}

/**
 * The bar's fixed size, for whoever moves it. It is always written along with
 * the position and never read back: setPosition() writes back the size Windows
 * reports, which across screens of different scaling (125% and 200%) is
 * converted at the wrong one, so the bar grew or shrank while dragged.
 */
export function getMiniBarSize(window: BrowserWindow): { width: number; height: number } | null {
  return window === miniBarWindow ? { width: MINI_BAR_WIDTH, height: MINI_BAR_HEIGHT } : null
}

/**
 * Show the bar where the user left it, or at `anchor` (the main window's
 * top-left corner) the first time, kept inside a connected display either way.
 */
export function showMiniBar(anchor?: [number, number]): void {
  const window = ensureMiniBarWindow()
  if (!window) return
  const [x, y] = miniBarPosition ?? anchor ?? window.getPosition()
  const workArea = screen.getDisplayMatching({
    x,
    y,
    width: MINI_BAR_WIDTH,
    height: MINI_BAR_HEIGHT
  }).workArea
  window.setBounds({
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - MINI_BAR_WIDTH),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - MINI_BAR_HEIGHT),
    width: MINI_BAR_WIDTH,
    height: MINI_BAR_HEIGHT
  })
  isMiniBarShown = true
  if (isMiniBarReady) presentMiniBar(window)
}

function presentMiniBar(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  applyContentProtection(window, true)
  window.showInactive()
  window.setAlwaysOnTop(true, 'screen-saver', MINI_BAR_RELATIVE_LEVEL)
  window.moveTop()
  startTopMostGuard()
}

/** The window-moving shortcuts move the bar while it stands in for the main window */
export function moveMiniBar(dx: number, dy: number): void {
  if (!miniBarWindow || miniBarWindow.isDestroyed()) return
  const [x, y] = miniBarWindow.getPosition()
  miniBarWindow.setBounds({ x: x + dx, y: y + dy, width: MINI_BAR_WIDTH, height: MINI_BAR_HEIGHT })
}

export function hideMiniBar(): void {
  stopTopMostGuard()
  if (!isMiniBarShown) return
  isMiniBarShown = false
  if (!miniBarWindow || miniBarWindow.isDestroyed()) return
  miniBarPosition = miniBarWindow.getPosition() as [number, number]
  miniBarWindow.hide()
}

/** The mode whose buttons the bar shows, if `sender` is the bar's own renderer */
export function miniBarModeOf(sender: WebContents): AppMode | null {
  if (!miniBarWindow || miniBarWindow.isDestroyed()) return null
  return sender === miniBarWindow.webContents ? miniBarState.mode : null
}

/**
 * Shown, even if a newly created window has yet to paint: the keys it stands
 * in for must be held from the moment it was asked for
 */
export function isMiniBarVisible(): boolean {
  return isMiniBarShown && !!miniBarWindow && !miniBarWindow.isDestroyed()
}

/** Other apps claim the top spot too; reclaim it without moveTop(), which would disturb them */
function startTopMostGuard(): void {
  if (topMostGuard) return
  topMostGuard = setInterval(() => {
    if (!isMiniBarVisible()) {
      stopTopMostGuard()
      return
    }
    miniBarWindow!.setAlwaysOnTop(true, 'screen-saver', MINI_BAR_RELATIVE_LEVEL)
  }, TOP_MOST_GUARD_INTERVAL)
}

function stopTopMostGuard(): void {
  if (topMostGuard) clearInterval(topMostGuard)
  topMostGuard = null
}

/** As translucent as the main window, like the toolbar */
export function setMiniBarOpacity(opacity: number): void {
  miniBarOpacity = opacity
  if (!miniBarWindow || miniBarWindow.isDestroyed()) return
  miniBarWindow.setOpacity(opacity)
}

/** Its renderer has its own store copy, so it gets the toolbar's settings pushed the same way */
export function sendToMiniBar(channel: string, payload: unknown): void {
  if (!miniBarWindow || miniBarWindow.isDestroyed()) return
  miniBarWindow.webContents.send(channel, payload)
}
