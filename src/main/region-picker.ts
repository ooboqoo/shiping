import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, type Display, type NativeImage } from 'electron'
import { is } from '@electron-toolkit/utils'
import { registerStealthWindow } from './window-privacy'
import type { CaptureRegion, RegionRect } from '../shared/capture-region'
import {
  captureScreens,
  cropScreenshot,
  findScreenSource,
  settingsResolution
} from './take-screenshot'

/**
 * `region`: the area every later screenshot is cropped to, confirmed with
 * Enter / double-click. `screenshot`: one screenshot of the area, taken the
 * moment the drag ends (and either sent or held for a question, see `askFirst`).
 */
export type PickerPurpose = 'region' | 'screenshot'

/** What a picker window draws on: its screen, frozen, and the region already set there */
export interface RegionPickerData {
  purpose: PickerPurpose
  /** A one-off screenshot added to the current conversation instead of starting one */
  append: boolean
  /**
   * A one-off screenshot waits for a question unless Shift is held on release
   * (「框选后」 set to 先输入问题); false: it is sent unless Shift is held
   */
  askFirst: boolean
  /** JPEG data URL of the screen as it was when picking started */
  image: string
  /** The saved region, when it is on this screen */
  region: RegionRect | null
  /** The screen's resolution as its display settings show it, for the size readout */
  width: number
  height: number
}

interface Picker {
  window: BrowserWindow
  display: Display
  /** The frozen screen, at full resolution */
  capture: NativeImage
  image: string
}

interface Picked {
  region: CaptureRegion
  picker: Picker
  /** Shift was held as the drag ended: the other of the two 「框选后」 behaviours */
  shift: boolean
}

/** A one-off screenshot, and whether the user wants to ask about it first */
export interface PickedScreenshot {
  /** base64 PNG */
  image: string
  ask: boolean
}

/** Above the main window (100) and the toolbar (101) at the same `screen-saver` level */
const PICKER_RELATIVE_LEVEL = 200
/** Last resort against a picker that never answers: it covers every screen */
const PICKER_TIMEOUT = 5 * 60 * 1000
/**
 * A picker stays hidden until its page says it is painted, and the main window
 * is hidden meanwhile: if none shows by then, cancel, or the app just vanishes
 */
const PICKER_SHOW_TIMEOUT = 10 * 1000

/** Set before the first await, so a second request cannot slip in while the screens are captured */
let active = false
let pickers: Picker[] = []
let purpose: PickerPurpose = 'region'
let appending = false
let asking = false
let savedRegion: CaptureRegion | null = null
let settle: ((picked: Picked | null) => void) | null = null
let timeout: NodeJS.Timeout | null = null

/**
 * Let the user drag out the area screenshots are cropped to. Resolves with the
 * new region, or null if cancelled.
 */
export async function pickCaptureRegion(
  current: CaptureRegion | null
): Promise<CaptureRegion | null> {
  return (await pick('region', current))?.region ?? null
}

/**
 * Let the user drag out an area and screenshot just that, once, leaving the
 * capture region as it is. The screenshot is cut from the frozen screen the
 * user dragged on, so it holds exactly what they saw, even a menu or tooltip
 * that closed when the picker took focus. `append` only changes what the page
 * says the screenshot is for. `askFirst`: release asks for a question first
 * and Shift + release sends, else the other way round (「框选后」). Resolves
 * with the screenshot, or null if cancelled.
 */
export async function pickScreenshot({
  append = false,
  askFirst = false
} = {}): Promise<PickedScreenshot | null> {
  const picked = await pick('screenshot', null, append, askFirst)
  if (!picked) return null
  const image = cropScreenshot(picked.picker.capture, picked.picker.display, picked.region)
  return { image, ask: picked.shift !== askFirst }
}

/**
 * Every screen gets a full-screen window showing a frozen capture of itself,
 * so the user picks from exactly what a screenshot will see (the app's own
 * windows are left out by content protection).
 */
async function pick(
  as: PickerPurpose,
  current: CaptureRegion | null,
  append = false,
  askFirst = false
): Promise<Picked | null> {
  if (active) return null
  active = true

  const displays = screen.getAllDisplays()
  // Sized for the densest screen, so no background is blurrier than the screen under it
  const thumbnailSize = {
    width: Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor))),
    height: Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)))
  }
  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await captureScreens(thumbnailSize, displays)
  } catch (error) {
    active = false
    throw error
  }

  return new Promise((resolve) => {
    settle = resolve
    purpose = as
    appending = append
    asking = askFirst
    savedRegion = current
    pickers = displays.flatMap((display) => {
      const source = findScreenSource(sources, display)
      // An empty capture never loads in the page, so its window would never show
      if (!source || source.thumbnail.isEmpty()) return []
      const capture = source.thumbnail
      const image = `data:image/jpeg;base64,${capture.toJPEG(90).toString('base64')}`
      return [{ display, capture, image, window: createPickerWindow(display) }]
    })
    if (pickers.length === 0) {
      finish(null)
      return
    }
    armTimeout(PICKER_SHOW_TIMEOUT)
  })
}

function armTimeout(ms: number): void {
  if (timeout) clearTimeout(timeout)
  timeout = setTimeout(() => finish(null), ms)
}

function createPickerWindow(display: Display): BrowserWindow {
  const window = new BrowserWindow({
    ...display.bounds,
    title: '',
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Cover the menu bar on macOS instead of being pushed below it
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    // Over other apps' fullscreen Spaces, like the main window (see main-window.ts)
    ...(process.platform === 'darwin' && { type: 'panel' }),
    hasShadow: false,
    // Started from a shortcut the app is in the background, and the first
    // click would otherwise only bring the window forward instead of dragging
    acceptFirstMouse: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.setAlwaysOnTop(true, 'screen-saver', PICKER_RELATIVE_LEVEL)
  // Transforming the process type would hide the Dock icon, and nothing shows it again after a cancel
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })
  registerStealthWindow(window, '识屏 · 框选区域')
  // Mixed-DPI setups on Windows can size a window created with bounds slightly off
  window.setBounds(display.bounds)

  // Closing any one picker, or one that failed, cancels the whole pick: they
  // cover every screen, so none may be left behind
  window.on('closed', () => finish(null))
  window.webContents.on('render-process-gone', () => finish(null))
  window.webContents.on('did-fail-load', () => finish(null))
  window.on('unresponsive', () => finish(null))

  // A page of its own: the app's bundle would take longer to load than the capture
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/picker.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/picker.html'))
  }
  return window
}

function finish(picked: Picked | null): void {
  const resolve = settle
  if (!resolve) return
  settle = null
  active = false
  if (timeout) clearTimeout(timeout)
  timeout = null

  const closing = pickers
  pickers = []
  for (const picker of closing) {
    if (!picker.window.isDestroyed()) picker.window.destroy()
  }
  resolve(picked)
}

function pickerOf(sender: Electron.WebContents): Picker | undefined {
  return pickers.find((p) => !p.window.isDestroyed() && p.window.webContents === sender)
}

ipcMain.handle('getRegionPickerData', (event): RegionPickerData | null => {
  const picker = pickerOf(event.sender)
  if (!picker) return null
  const displayId = String(picker.display.id)
  return {
    purpose,
    append: appending,
    askFirst: asking,
    image: picker.image,
    region: savedRegion?.displayId === displayId ? savedRegion : null,
    ...settingsResolution(picker.display)
  }
})

// Shown only once its frozen screen is painted, so the user never sees it flash black
ipcMain.on('region-picker-ready', (event) => {
  const picker = pickerOf(event.sender)
  if (!picker) return
  picker.window.show()
  armTimeout(PICKER_TIMEOUT)
  // Keyboard goes to the screen the user is on, for Enter / Esc. Started from a
  // shortcut or the toolbar, another app is active; unless this one takes over,
  // the Enter meant to confirm would land in that app, e.g. submit an exam page
  const cursor = screen.getCursorScreenPoint()
  if (screen.getDisplayNearestPoint(cursor).id !== picker.display.id) return
  if (process.platform === 'darwin') app.focus({ steal: true })
  picker.window.focus()
})

/** A usable area: inside the screen and not empty */
function isRegionRect(rect: RegionRect | null): rect is RegionRect {
  if (!rect) return false
  const { x, y, width, height } = rect
  return (
    [x, y, width, height].every(Number.isFinite) &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= 1 &&
    y + height <= 1
  )
}

ipcMain.on('finish-region-picker', (event, rect: RegionRect | null, shift?: boolean) => {
  const picker = pickerOf(event.sender)
  if (!picker) return
  if (!isRegionRect(rect)) return finish(null)
  const { x, y, width, height } = rect
  finish({
    region: { displayId: String(picker.display.id), x, y, width, height },
    picker,
    shift: shift === true
  })
})
