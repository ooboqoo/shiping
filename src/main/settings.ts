import { app, dialog, ipcMain } from 'electron'
import type { CaptureRegion } from '../shared/capture-region'
import type { ApiProfile, AppMode } from '../shared/api-profile'
import type { HintMode } from '../shared/conversation'
import { setToolbarOpacity, syncToolbarSettings } from './toolbar-window'
import { DEFAULT_PROXY, normalizeProxySettings } from '../shared/proxy'
import { setStealthEnabled } from './window-privacy'

ipcMain.handle('getAppVersion', () => {
  return app.getVersion()
})

ipcMain.handle('getAppSettings', () => {
  return settings
})

type SettingsListener = (previous: AppSettings) => void
const settingsListeners: SettingsListener[] = []

/** Run `listener` after every update from the renderer, with the settings as they were before it */
export function onSettingsChanged(listener: SettingsListener): void {
  settingsListeners.push(listener)
}

ipcMain.handle('updateAppSettings', (_event, _settings) => {
  if ('networkProxy' in _settings) {
    _settings = { ..._settings, networkProxy: normalizeProxySettings(_settings.networkProxy) }
  }
  const previous = { ...settings }
  Object.assign(settings, _settings)
  if (settings.stealthEnabled !== previous.stealthEnabled) {
    setStealthEnabled(settings.stealthEnabled)
  }
  for (const listener of settingsListeners) listener(previous)
  if ('hideDockIcon' in _settings) {
    applyDockVisibility(settings.hideDockIcon)
  }
  if ('opacity' in _settings) {
    setToolbarOpacity(settings.opacity)
  }
  if ('toolbarHoverDelay' in _settings || 'theme' in _settings) {
    syncToolbarSettings({
      hoverDelay: settings.toolbarHoverDelay,
      theme: settings.theme
    })
  }
})

/** Show/hide the macOS dock icon. No-op on other platforms. */
export function applyDockVisibility(hidden: boolean): void {
  if (process.platform !== 'darwin') return
  if (hidden) {
    app.dock?.hide()
  } else {
    app.dock?.show()
  }
}

/** Ask for a folder; null if the user cancels */
async function pickDirectory(title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

ipcMain.handle('selectScreenshotDir', () => pickDirectory('选择截图保存目录'))
ipcMain.handle('selectCodeDir', () => pickDirectory('选择代码保存目录'))
ipcMain.handle('selectConversationDir', () => pickDirectory('选择对话记录保存目录'))

export const settings = {
  networkProxy: { ...DEFAULT_PROXY },
  /** Window colour scheme, kept in sync with the renderer; see renderer lib/theme.ts */
  theme: 'dark' as 'dark' | 'light',
  apiBaseURL: process.env.API_BASE_URL || '',
  apiKey: process.env.API_KEY || '',
  /** Extra request headers, one `Name: Value` per line; see shared/request-headers.ts */
  apiHeaders: '',
  model: process.env.MODEL || '',
  /**
   * The active profile's 「关闭思考」, see thinking.ts. Must stay falsy here:
   * App.tsx fills blank renderer fields from main, so `true` would overwrite a
   * user's "off".
   */
  disableThinking: false,
  /** Every saved AI profile, synced from the renderer; each mode picks one by id */
  apiProfiles: [] as ApiProfile[],
  screenshotProfileId: '',
  conversationProfileId: '',
  /** 截图模式's system prompt, from the renderer's active scene */
  customPrompt: '',
  /** 对话模式's system prompt, from the renderer's active scene */
  conversationPrompt: '',
  /** 对话模式: hint on every finished sentence (`auto`) or only on the shortcut */
  conversationHintMode: 'auto' as HintMode,
  /** 对话模式: silence (ms) that ends a sentence in the recogniser */
  conversationSilenceMs: 800,
  /** 对话模式: a finished sentence shorter than this triggers no automatic hint */
  conversationMinChars: 4,
  /** 对话模式: keep each conversation as a Markdown file, see save-conversation.ts */
  conversationAutoSave: false,
  /** Where the conversations go; blank means Documents/Shiping */
  conversationSaveDir: '',
  /** Kept in sync with the renderer so the overlay toolbar can match the main window */
  opacity: 0.8,
  /**
   * Dwell time in ms before hovering a toolbar button fires it; 0 disables hover
   * triggering. The real default lives in the renderer store: App.tsx fills blank
   * renderer fields from here, so a truthy default would overwrite a user's "off".
   */
  toolbarHoverDelay: 0,
  /** Screen to capture: `cursor` follows the mouse, anything else is a fixed `Display.id` */
  captureScreen: 'cursor',
  /** Crop every screenshot to this area of one screen; null captures the whole screen */
  captureRegion: null as CaptureRegion | null,
  screenshotAutoSave: false,
  screenshotDir: '',
  /** Save the code block of a finished answer as a source file */
  codeAutoSave: false,
  codeSaveDir: '',
  /** Base file name for saved code; blank falls back to `Test` */
  codeFileBaseName: 'Test',
  /** `sequence` appends a number (Test1, Test2); `overwrite` reuses one name */
  codeNamingMode: 'sequence' as 'sequence' | 'overwrite',
  /** Copy the code block of a finished answer to the system clipboard */
  codeCopyToClipboard: false,
  dashscopeApiKey: '',
  /** 手机同步 over the LAN: the app serves the phone page itself, see mobile-sync.ts */
  mobileLanEnabled: false,
  /** The LAN page's secret, made by the renderer on first use; a new one voids every QR code */
  mobileLanKey: '',
  /** 手机同步 through relay/server.mjs on a public server */
  mobileRelayEnabled: false,
  mobileRelayURL: '',
  /** The server's RELAY_KEY */
  mobileRelayKey: '',
  /** Hide app windows from screenshots and screen sharing; the renderer persists this preference */
  stealthEnabled: true,
  hideDockIcon: false,
  /** The macOS menu bar icon, see tray.ts */
  hideTrayIcon: false,
  audioInputDeviceId: '',
  audioOutputDeviceId: ''
}

export type AppSettings = typeof settings

/**
 * The profile a mode sends its requests with. Until the renderer has synced
 * its list (or with only `.env` configured) the flat fields are all there is.
 */
export function getModeProfile(mode: AppMode): ApiProfile {
  const id = mode === 'screenshot' ? settings.screenshotProfileId : settings.conversationProfileId
  const profile = settings.apiProfiles.find((p) => p.id === id)
  if (profile) return profile
  return {
    id: '',
    name: '',
    apiBaseURL: settings.apiBaseURL,
    apiKey: settings.apiKey,
    apiHeaders: settings.apiHeaders,
    model: settings.model,
    disableThinking: settings.disableThinking
  }
}
