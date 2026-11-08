import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import { getMiniBarSize } from './mini-bar-window'

/** A resize by one edge or corner, or `move`: the whole window follows the cursor */
export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'move'

type ResizeState = {
  window: BrowserWindow
  direction: ResizeDirection
  startX: number
  startY: number
  bounds: Rectangle
  lastX: number
  lastY: number
}

const MIN_WIDTH = 200
/** Low enough to leave the main window a usable header strip */
const MIN_HEIGHT = 36
/** Cursor sampling interval while dragging, roughly one frame */
const POLL_INTERVAL = 16
/** Only the renderer can end a drag, so never follow the cursor indefinitely */
const MAX_DRAG_DURATION = 30_000
/** Long enough for Windows to have rescaled a window just dropped onto a screen of other scaling */
const MOVE_SETTLE_DELAY = 100

let resizeState: ResizeState | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The cursor is sampled here instead of being sent from the renderer, which
 * would need pointer capture to keep getting moves once the cursor leaves the
 * window, and capture is best-effort on a macOS panel (see WindowResizeHandles).
 * A pointerdown and a pointerup are all the renderer has to deliver.
 */
ipcMain.on('window-resize-start', (event, direction: ResizeDirection) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return

  const { x, y } = screen.getCursorScreenPoint()
  resizeState = {
    window,
    direction,
    startX: x,
    startY: y,
    bounds: window.getBounds(),
    lastX: x,
    lastY: y
  }

  stopTimers()
  pollTimer = setInterval(trackCursor, POLL_INTERVAL)
  safetyTimer = setTimeout(stopResize, MAX_DRAG_DURATION)
})

ipcMain.on('window-resize-stop', (event) => {
  if (resizeState?.window.webContents === event.sender) stopResize()
})

function trackCursor(): void {
  if (!resizeState || resizeState.window.isDestroyed()) {
    stopResize()
    return
  }

  const { x, y } = screen.getCursorScreenPoint()
  if (x === resizeState.lastX && y === resizeState.lastY) return
  resizeState.lastX = x
  resizeState.lastY = y

  // Every frame is derived from the bounds snapshotted at drag start, so the
  // rounding of a single getBounds() cannot accumulate
  if (resizeState.direction === 'move') {
    const { window, bounds, startX, startY } = resizeState
    window.setBounds({
      x: bounds.x + x - startX,
      y: bounds.y + y - startY,
      ...moveSize(window, bounds)
    })
    return
  }
  resizeState.window.setBounds(resizeBounds(resizeState, x, y))
}

/**
 * A move writes the size along with the position, never setPosition() alone:
 * that writes back the size Windows reports, which on a screen of different
 * scaling is converted at the wrong one, so the window grew with every frame.
 * The 极简悬浮条 has a fixed size; anything else keeps its size at drag start.
 */
function moveSize(window: BrowserWindow, bounds: Rectangle): { width: number; height: number } {
  return getMiniBarSize(window) ?? { width: bounds.width, height: bounds.height }
}

function stopResize(): void {
  stopTimers()
  if (resizeState?.direction === 'move') settleMove(resizeState)
  resizeState = null
}

/**
 * Crossing onto a screen of other scaling, Windows rescales the window once by
 * the ratio of the two (75×33 for 120×44 from 125% to 200%); the next frame
 * puts the size back. A drop on that very frame would keep it, so it is put
 * back once more after the drop.
 */
function settleMove({ window, bounds }: ResizeState): void {
  setTimeout(() => {
    if (window.isDestroyed()) return
    const [x, y] = window.getPosition()
    window.setBounds({ x, y, ...moveSize(window, bounds) })
  }, MOVE_SETTLE_DELAY)
}

function stopTimers(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (safetyTimer) clearTimeout(safetyTimer)
  pollTimer = null
  safetyTimer = null
}

function resizeBounds(state: ResizeState, x: number, y: number): Rectangle {
  const { bounds, direction, startX, startY } = state
  const dx = x - startX
  const dy = y - startY
  let { x: left, y: top, width, height } = bounds

  if (direction.includes('e')) width = Math.max(MIN_WIDTH, width + dx)
  if (direction.includes('s')) height = Math.max(MIN_HEIGHT, height + dy)
  if (direction.includes('w')) {
    const nextWidth = Math.max(MIN_WIDTH, width - dx)
    left += width - nextWidth
    width = nextWidth
  }
  if (direction.includes('n')) {
    const nextHeight = Math.max(MIN_HEIGHT, height - dy)
    top += height - nextHeight
    height = nextHeight
  }

  return { x: left, y: top, width, height }
}
