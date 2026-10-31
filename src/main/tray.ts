import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import templateIconPath from '../../resources/trayTemplate.png?asset&asarUnpack'
import windowsIconPath from '../../resources/tray.ico?asset&asarUnpack'
import { settings, onSettingsChanged } from './settings'
import { state } from './state'
import {
  isMainWindowShown,
  registeredShortcut,
  revealMainWindow,
  runShortcutAction
} from './shortcuts'

/**
 * The tray icon (macOS menu bar, Windows notification area). It is there for
 * 框选识别: a click starts it like the shortcut, so the app can stay hidden in
 * the background and still be used with the mouse alone. Right-click (or
 * Control-click on macOS) opens a menu with 框选识别 too, show / hide, the
 * settings and quit. Both platforms behave alike: a left click is the primary
 * action on Windows as well, and the menu is its usual right-click.
 *
 * Shown by default, but like the Dock icon it waits for the renderer's
 * `hideTrayIcon`: main does not know the persisted value at startup, and a
 * user who keeps it hidden must not see it flash. No tooltip: it is drawn
 * outside content protection and would name the app on a shared screen.
 */
let tray: Tray | null = null

function openSettings(): void {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  revealMainWindow(mainWindow)
  // The renderer owns the routes
  mainWindow.webContents.send('open-settings')
}

/** Built on every opening, so it reflects the window and the shortcuts as they are now */
function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      // Like the shortcut, it works only with 截图模式's page loaded, hidden or not
      label: state.inCoderPage ? '框选识别' : '框选识别（需在截图模式下）',
      enabled: state.inCoderPage,
      accelerator: registeredShortcut('snipScreenshot'),
      registerAccelerator: false,
      click: () => runShortcutAction('snipScreenshot')
    },
    { type: 'separator' },
    {
      label: isMainWindowShown() ? '隐藏窗口' : '显示窗口',
      accelerator: registeredShortcut('hideOrShowMainWindow'),
      registerAccelerator: false,
      click: () => runShortcutAction('hideOrShowMainWindow')
    },
    { label: '设置…', click: openSettings },
    { type: 'separator' },
    { label: '退出识屏', click: () => app.quit() }
  ])
}

function createTray(): Tray {
  let icon: NativeImage
  if (process.platform === 'darwin') {
    // A template image: macOS tints it to match the menu bar, light or dark
    icon = nativeImage.createFromPath(templateIconPath)
    icon.setTemplateImage(true)
  } else {
    // The app icon's small sizes, for Windows to pick by the screen's scaling
    icon = nativeImage.createFromPath(windowsIconPath)
  }
  const created = new Tray(icon)
  const popUp = () => created.popUpContextMenu(buildMenu())
  created.on('click', (event) => {
    // Control-click is the right-click of a one-button mouse. Off 截图模式 a
    // click would do nothing, so it opens the menu, which says why
    if ((process.platform === 'darwin' && event.ctrlKey) || !state.inCoderPage) popUp()
    else runShortcutAction('snipScreenshot')
  })
  created.on('right-click', popUp)
  return created
}

function applyTrayVisibility(hidden: boolean): void {
  if (hidden) {
    tray?.destroy()
    tray = null
  } else if (!tray) {
    tray = createTray()
  }
}

onSettingsChanged(() => applyTrayVisibility(settings.hideTrayIcon))
