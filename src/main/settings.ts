import { app, dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import type { CaptureRegion } from '../shared/capture-region'
import {
  normalizeReasoningEffort,
  type ApiProfile,
  type AppMode,
  type ReasoningEffort
} from '../shared/api-profile'
import type { HintMode } from '../shared/conversation'
import { setToolbarEnabled, setToolbarOpacity, syncToolbarSettings } from './toolbar-window'
import { createToolbarButtons } from '../shared/toolbar'
import { DEFAULT_PROXY, normalizeProxySettings } from '../shared/proxy'
import {
  DEFAULT_EXTERNAL_KNOWLEDGE,
  normalizeExternalKnowledge
} from '../shared/external-knowledge'
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
  if ('externalKnowledge' in _settings) {
    _settings = {
      ..._settings,
      externalKnowledge: normalizeExternalKnowledge(_settings.externalKnowledge)
    }
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
  if ('showOverlayToolbar' in _settings) {
    setToolbarEnabled(settings.showOverlayToolbar)
  }
  if ('opacity' in _settings) {
    setToolbarOpacity(settings.opacity)
  }
  if ('toolbarHoverDelay' in _settings || 'theme' in _settings || 'toolbarButtons' in _settings) {
    syncToolbarSettings({
      hoverDelay: settings.toolbarHoverDelay,
      theme: settings.theme,
      buttons: settings.toolbarButtons
    })
  }
})

/** What applyDockVisibility() last asked for; null before the first call */
let dockHidden: boolean | null = null

/** Show/hide the macOS dock icon. No-op on other platforms. */
export function applyDockVisibility(hidden: boolean): void {
  if (process.platform !== 'darwin') return
  // Every settings change syncs `hideDockIcon` again. dock.show() on an active
  // app hands activation to the Dock and takes it back a second later, which
  // drops an input method's composition: typing Chinese in the settings page
  // lost every syllable. So only an actual change touches the Dock
  if (hidden === dockHidden) return
  dockHidden = hidden
  if (hidden) {
    app.dock?.hide()
  } else {
    app.dock?.show()
  }
}

/** Folder screenshots are saved to: the one chosen, else Pictures/Shiping */
export function screenshotSaveDir(): string {
  return settings.screenshotDir || join(app.getPath('pictures'), 'Shiping')
}

/** Folder 对话模式's records are saved to: the one chosen, else Documents/Shiping */
export function conversationSaveDir(): string {
  return settings.conversationSaveDir || join(app.getPath('documents'), 'Shiping')
}

/**
 * Where a file dialog opens: `path`, else its nearest existing parent. Since
 * Electron 43 the OS no longer remembers the last folder, so a dialog given
 * none starts in Downloads every time
 */
export function dialogStartDir(path: string | undefined): string | undefined {
  if (!path || !isAbsolute(path)) return undefined
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(dir)) return dir
    if (dirname(dir) === dir) return undefined
  }
}

/** Ask for a folder, opening at `current`; null if the user cancels */
async function pickDirectory(title: string, current: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title,
    defaultPath: dialogStartDir(current)
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

ipcMain.handle('selectScreenshotDir', () => pickDirectory('选择截图保存目录', screenshotSaveDir()))
ipcMain.handle('selectCodeDir', () => pickDirectory('选择代码保存目录', settings.codeSaveDir))
ipcMain.handle('selectConversationDir', () =>
  pickDirectory('选择对话记录保存目录', conversationSaveDir())
)

export const settings = {
  networkProxy: { ...DEFAULT_PROXY },
  /** 外部知识库, see external-knowledge.ts; read through normalizeExternalKnowledge() */
  externalKnowledge: { ...DEFAULT_EXTERNAL_KNOWLEDGE, modes: [] as AppMode[] },
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
  /** The active profile's 「思考强度」; empty leaves it to the model */
  reasoningEffort: '' as ReasoningEffort,
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
  /**
   * The overlay toolbar's window exists only while this is on, see
   * toolbar-window.ts. Must stay falsy here: App.tsx fills blank renderer
   * fields from main, so `true` would overwrite a user's "off"
   */
  showOverlayToolbar: false,
  /** Kept in sync with the renderer so the overlay toolbar can match the main window */
  opacity: 0.8,
  /**
   * Dwell time in ms before hovering a toolbar button fires it; 0 disables hover
   * triggering. The real default lives in the renderer store: App.tsx fills blank
   * renderer fields from here, so a truthy default would overwrite a user's "off".
   */
  toolbarHoverDelay: 0,
  /** The buttons the user turned on or off per mode, see shared/toolbar.ts */
  toolbarButtons: createToolbarButtons(),
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
  /** The tray icon (macOS menu bar, Windows notification area), see tray.ts */
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
    disableThinking: settings.disableThinking,
    reasoningEffort: normalizeReasoningEffort(settings.reasoningEffort)
  }
}
