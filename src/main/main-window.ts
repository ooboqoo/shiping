import { join } from 'node:path'
import { shell, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { attachToolbar } from './toolbar-window'
import { applyContentProtection, registerStealthWindow } from './window-privacy'
import { syncShortcuts, watchMainWindowFocus } from './shortcuts'

export function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    title: '',
    frame: false,
    transparent: true,
    hasShadow: false,
    // Native resize toggling breaks transparency on Windows; renderer handles own resizing.
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    // macOS shows a regular app's window over another app's fullscreen Space
    // only if its Spaces flags were set while the app had no Dock icon, and the
    // Dock icon is on by default. A non-activating panel is let in either way
    ...(process.platform === 'darwin' && { type: 'panel' }),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Soft-hide parks the window off-screen, which makes Windows report the
      // window as occluded; with throttling on, the renderer freezes until the
      // window is focused again (queued IPC flushes on click, toolbar hover
      // dwell timers never fire).
      backgroundThrottling: false
    }
  })

  // Store reference to mainWindow globally
  global.mainWindow = mainWindow
  // The toolbar follows the main window's position and visibility on its own
  attachToolbar(mainWindow)

  mainWindow.setMenuBarVisibility(false)

  registerStealthWindow(mainWindow, '识屏 Shiping', true)
  watchMainWindowFocus(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    // The renderer may have sent its shortcuts already, while the window was hidden
    syncShortcuts()
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    // The panel type is what keeps it over fullscreen apps; transforming the
    // process type would only hide the Dock icon. Dock visibility is handled
    // at startup (index.ts) and via renderer sync (settings.ts).
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    applyContentProtection(mainWindow)

    // Reclaim top position when other apps steal it
    mainWindow.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
      if (!isAlwaysOnTop && mainWindow.isVisible() && !mainWindow.isDestroyed()) {
        // Only re-set the flag; avoid moveTop() to not disturb other window focus
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
      }
    })
  })

  mainWindow.on('show', () => {
    applyContentProtection(mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
