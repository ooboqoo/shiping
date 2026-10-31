import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { registerStealthWindow } from './window-privacy'

/** Room for every button of the longer mode's toolbar: 16 × 28px, 2px gaps, 8px padding each side */
const TOOLBAR_WIDTH = 494
const TOOLBAR_HEIGHT = 44
const TOOLBAR_INSET = 4
/** Mirrors the renderer's default opacity setting, until the renderer syncs the real one */
const DEFAULT_OPACITY = 0.8

let toolbarWindow: BrowserWindow | null = null
let ownerWindow: BrowserWindow | null = null
/** Whether the renderer wants the toolbar on screen (main page + enabled in settings) */
let isToolbarWanted = false
let toolbarOpacity = DEFAULT_OPACITY
/**
 * The size the user dragged the toolbar to, tracked here instead of being read
 * back off the window. Windows encloses in both directions of the DIP <-> pixel
 * conversion, so at fractional display scaling a getBounds() -> setBounds()
 * round trip hands back a window one pixel larger; syncToolbarBounds runs on
 * every move event of a window drag, which turned that into unbounded growth.
 */
let toolbarSize = { width: TOOLBAR_WIDTH, height: TOOLBAR_HEIGHT }

/**
 * Click-through alternative to the global shortcuts: a small always-on-top
 * window of buttons, glued above the main window and hidden along with it.
 *
 * The window itself exists only while the setting is on: it is a renderer of
 * its own, kept for nothing by someone who never uses it. Like the tray icon
 * it waits for the renderer's setting, so it is created by the first sync
 */
export function attachToolbar(parent: BrowserWindow): void {
  ownerWindow = parent
  parent.on('move', syncToolbarBounds)
  parent.on('resize', syncToolbarBounds)
  parent.on('show', showToolbar)
  parent.on('hide', hideToolbar)
  parent.on('closed', () => {
    destroyToolbarWindow()
    ownerWindow = null
  })
}

/** Create or destroy the window as the `showOverlayToolbar` setting says */
export function setToolbarEnabled(enabled: boolean): void {
  if (!enabled) destroyToolbarWindow()
  else if (!toolbarWindow && ownerWindow && !ownerWindow.isDestroyed()) {
    createToolbarWindow(ownerWindow)
  }
}

function destroyToolbarWindow(): void {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.destroy()
  toolbarWindow = null
}

function createToolbarWindow(parent: BrowserWindow): void {
  const window = new BrowserWindow({
    width: TOOLBAR_WIDTH,
    height: TOOLBAR_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    // Native resize toggling breaks transparency on Windows; renderer handles own resizing.
    resizable: false,
    // Clicking a button must never pull focus away from what the user is doing
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Over other apps' fullscreen Spaces, like the main window (see main-window.ts)
    ...(process.platform === 'darwin' && { type: 'panel' }),
    show: false,
    parent,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Hover dwell runs on setTimeout in this renderer; it must not be
      // throttled while the window is hidden/occluded (see main-window.ts).
      backgroundThrottling: false
    }
  })
  toolbarWindow = window

  window.setMenuBarVisibility(false)
  window.setOpacity(toolbarOpacity)
  window.setAlwaysOnTop(true, 'screen-saver', 2)
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })
  registerStealthWindow(window, '识屏 · 悬浮工具条')
  // Turned on while the main page is up, it shows once it has something to show
  window.once('ready-to-show', showToolbar)
  window.on('closed', () => {
    if (toolbarWindow === window) toolbarWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/toolbar`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/toolbar' })
  }
}

/** Park the toolbar right above the main window, kept inside the current display */
function syncToolbarBounds(): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  if (!ownerWindow || ownerWindow.isDestroyed()) return

  const mainBounds = ownerWindow.getBounds()
  const workArea = screen.getDisplayMatching(mainBounds).workArea
  // Keep whatever size the user dragged it to; the constants only seed the window
  const width = Math.min(toolbarSize.width, workArea.width)
  const height = Math.min(toolbarSize.height, workArea.height)
  toolbarWindow.setBounds({
    x: Math.min(Math.max(mainBounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.max(workArea.y, mainBounds.y - height - TOOLBAR_INSET),
    width,
    height
  })
}

/** Show the toolbar only if the renderer asked for it and the main window is on screen */
export function showToolbar(): void {
  if (!isToolbarWanted) return
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  if (!ownerWindow || ownerWindow.isDestroyed() || !ownerWindow.isVisible()) return

  syncToolbarBounds()
  toolbarWindow.showInactive()
}

export function hideToolbar(): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  toolbarWindow.hide()
}

/**
 * Record a size the user dragged the toolbar to, so that syncToolbarBounds can
 * reapply it without ever reading it back from the window.
 */
export function noteToolbarResize(window: BrowserWindow, width: number, height: number): void {
  if (window !== toolbarWindow) return
  toolbarSize = { width, height }
}

/**
 * The renderer owns whether the toolbar belongs on screen (main page + the
 * `showOverlayToolbar` setting); main only decides when it can actually show.
 */
export function setToolbarWanted(wanted: boolean): void {
  isToolbarWanted = wanted
  if (wanted) {
    showToolbar()
  } else {
    hideToolbar()
  }
}

/**
 * Send a message to the toolbar's own renderer. Its store is a separate copy
 * of the main window's, so anything it displays has to be pushed explicitly.
 */
export function sendToToolbar(channel: string, payload: unknown): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  toolbarWindow.webContents.send(channel, payload)
}

/**
 * Keep the toolbar as translucent as the main window. The main window applies
 * opacity to its body via CSS; the toolbar is nothing but that bar, so the same
 * value is applied to the whole window.
 */
export function setToolbarOpacity(opacity: number): void {
  toolbarOpacity = opacity
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  toolbarWindow.setOpacity(opacity)
}

/**
 * The toolbar lives in its own renderer, so it never sees the settings store
 * updates made in the main window; push the ones it needs over IPC instead.
 */
export function syncToolbarSettings(payload: {
  hoverDelay: number
  theme: 'dark' | 'light'
}): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return
  toolbarWindow.webContents.send('sync-toolbar-settings', payload)
}

/** Reclaim the top spot alongside the main window, without ever revealing a hidden toolbar */
export function reassertToolbarTopMost(level: number, aggressive: boolean): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible()) return
  toolbarWindow.setAlwaysOnTop(true, 'screen-saver', level)
  if (aggressive) toolbarWindow.moveTop()
}
