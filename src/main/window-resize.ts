import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'

export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

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
  resizeState.window.setBounds(resizeBounds(resizeState, x, y))
}

function stopResize(): void {
  stopTimers()
  resizeState = null
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
