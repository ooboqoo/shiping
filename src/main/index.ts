import 'dotenv/config'
import './legacy-name'
import { app, desktopCapturer, globalShortcut, session } from 'electron'

type AbortLikeError = {
  name?: string
  code?: string
  message?: unknown
}

// Swallow AbortError from user-initiated stream cancellations to keep console clean
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const err = error as AbortLikeError
  const message = typeof err.message === 'string' ? err.message : ''
  return err.name === 'AbortError' || err.code === 'ABORT_ERR' || /aborted/i.test(message)
}

process.on('unhandledRejection', (error) => {
  if (isAbortError(error)) return
  console.error(error)
})

process.on('uncaughtException', (error) => {
  if (isAbortError(error)) return
  console.error(error)
})
import { electronApp, optimizer } from '@electron-toolkit/utils'
import './shortcuts'
import './transcription'
import './conversation'
import './knowledge'
import './window-resize'
import './model-list'
import './proxy-ipc'
import './mobile-sync'
import './tray'
import { createWindow } from './main-window'
import { initAutoUpdater } from './auto-updater'
import { applyDockVisibility } from './settings'

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Hide the dock icon up front until the renderer syncs the real preference.
  // The persisted `hideDockIcon` value lives in the renderer, so the main
  // process doesn't know it yet at startup. Starting hidden avoids a dock
  // flash for users who keep it hidden; if disabled, the renderer sync will
  // show it again once the window mounts.
  applyDockVisibility(true)

  // Auto-approve getDisplayMedia for system audio loopback capture. A request
  // left unanswered never settles, and listening would silently do nothing:
  // getSources rejects on macOS without the screen recording permission
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .catch((err) => {
        console.error('Failed to get screen sources for system audio:', err)
        return []
      })
      .then((sources) => {
        if (sources.length > 0) {
          callback({ video: sources[0], audio: 'loopback' })
          return
        }
        // No video refuses the request (getDisplayMedia rejects with an
        // AbortError), and Electron throws for it as well
        try {
          callback({})
        } catch {
          // refused, as intended
        }
      })
  })

  // Auto-approve microphone access so users can enumerate and select audio input devices,
  // and clipboard writes for the copy buttons (navigator.clipboard.writeText)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (['media', 'microphone', 'audio', 'clipboard-sanitized-write'].includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // Configure auto-updater
  initAutoUpdater()

  // Clicking the Dock icon brings back a window hidden with the shortcut
  app.on('activate', function () {
    if (global.mainWindow && !global.mainWindow.isVisible()) {
      global.mainWindow.show()
    }
  })
})

// Closing the window quits, on macOS too: the main window is the whole app.
// Left running without it, the process would keep a tray icon whose actions
// all need that window, and no shortcuts. Hiding it (shortcut, tray menu, the
// header's 隐藏 button) keeps the app in the background
app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  app.quit()
})
