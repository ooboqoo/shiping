import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppSettings } from '../main/settings'
import type { AppState } from '../main/state'
import type { ListModelsOptions, ModelListResult } from '../main/model-list'
import type { DisplayOption } from '../main/take-screenshot'
import type { RegionPickerData } from '../main/region-picker'
import type { CaptureRegion, RegionRect } from '../shared/capture-region'
import type { TranscriptionOptions } from '../main/transcription'
import type { ConversationSnapshot, HintCard, Utterance } from '../shared/conversation'
import type { KnowledgeDoc, KnowledgeImportResult, KnowledgePatch } from '../shared/knowledge'
import type { AvailableUpdate } from '../shared/update'
import type { MobileSyncStatus } from '../shared/mobile'
import type { ProxySettings, ProxyDetection, ProxyTestResult } from '../shared/proxy'
import type { ApiProfile } from '../shared/api-profile'

// Custom APIs for renderer
const api = {
  // Get the installed app version (package.json version at build time)
  getAppVersion: () => ipcRenderer.invoke('getAppVersion') as Promise<string>,
  // A newer release main found (null: none); Windows downloads and installs it on request
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status') as Promise<AvailableUpdate | null>,
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback: (update: AvailableUpdate) => void) => {
    ipcRenderer.on('update-status', (_event, update: AvailableUpdate) => callback(update))
  },
  removeUpdateStatusListener: () => {
    ipcRenderer.removeAllListeners('update-status')
  },
  // Get app settings
  getAppSettings: () => ipcRenderer.invoke('getAppSettings'),
  // Update app settings
  updateAppSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('updateAppSettings', settings),
  // Fetch the model IDs an OpenAI-compatible platform serves (its `/models` endpoint)
  listModels: (baseURL: string, apiKey: string, options?: ListModelsOptions) =>
    ipcRenderer.invoke('listModels', baseURL, apiKey, options) as Promise<ModelListResult>,
  detectSystemProxy: (baseURL: string) =>
    ipcRenderer.invoke('proxy:detect', baseURL) as Promise<ProxyDetection>,
  testProxyConnection: (
    proxy: ProxySettings,
    profile: Pick<ApiProfile, 'apiBaseURL' | 'apiKey' | 'apiHeaders'>
  ) => ipcRenderer.invoke('proxy:test', proxy, profile) as Promise<ProxyTestResult>,

  // Resize transparent frameless windows without toggling Electron's native resizable style
  startWindowResize: (direction: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw') =>
    ipcRenderer.send('window-resize-start', direction),
  stopWindowResize: () => ipcRenderer.send('window-resize-stop'),

  // Update app state
  updateAppState: (state: Partial<AppState>) => ipcRenderer.invoke('updateAppState', state),
  getAppState: () => ipcRenderer.invoke('getAppState') as Promise<AppState>,
  // Listen for app state
  onSyncAppState: (callback: (state: AppState) => void) => {
    ipcRenderer.on('sync-app-state', (_event, state) => {
      callback(state)
    })
  },
  // Remove app state listener
  removeSyncAppStateListener: () => {
    ipcRenderer.removeAllListeners('sync-app-state')
  },

  // Init shortcuts
  initShortcuts: (shortcuts: Record<string, { action: string; key: string }>) =>
    ipcRenderer.invoke('initShortcuts', shortcuts),
  // Get shortcuts
  getShortcuts: () => ipcRenderer.invoke('getShortcuts'),
  // Update shortcuts
  updateShortcuts: (shortcuts: { action: string; key: string }[]) =>
    ipcRenderer.invoke('updateShortcuts', shortcuts),

  // Trigger the small set of user-facing actions exposed by the overlay toolbar.
  triggerAction: (
    action:
      | 'takeScreenshot'
      | 'appendScreenshot'
      | 'stopSolutionStream'
      | 'ignoreOrEnableMouse'
      | 'increaseOpacity'
      | 'decreaseOpacity'
      | 'pageUp'
      | 'pageDown'
      | 'moveMainWindowUp'
      | 'moveMainWindowDown'
      | 'moveMainWindowLeft'
      | 'moveMainWindowRight'
      | 'toggleTranscription'
      | 'clearTranscription'
      | 'pickCaptureRegion'
      | 'cycleScene'
      | 'generateHint'
      | 'toggleHintMode'
      | 'switchMode'
  ) => ipcRenderer.invoke('triggerAction', action),
  setToolbarVisible: (visible: boolean) => ipcRenderer.invoke('setToolbarVisible', visible),
  // Set click-through from the settings page; returns the state main ended up in
  setIgnoreMouse: (ignore: boolean) =>
    ipcRenderer.invoke('setIgnoreMouse', ignore) as Promise<boolean>,

  // Settings the toolbar window needs, pushed from main (its own store is a separate copy)
  onSyncToolbarSettings: (
    callback: (settings: { hoverDelay: number; theme: 'dark' | 'light' }) => void
  ) => {
    ipcRenderer.on('sync-toolbar-settings', (_event, settings) => {
      callback(settings)
    })
  },
  removeSyncToolbarSettingsListener: () => {
    ipcRenderer.removeAllListeners('sync-toolbar-settings')
  },

  // Listen for window opacity adjustments triggered by shortcuts
  onAdjustOpacity: (callback: (delta: number) => void) => {
    ipcRenderer.on('adjust-opacity', (_event, delta) => {
      callback(delta)
    })
  },
  removeAdjustOpacityListener: () => {
    ipcRenderer.removeAllListeners('adjust-opacity')
  },

  // Shortcut asked to step through the saved AI profiles (+1 / -1)
  onSwitchApiProfile: (callback: (direction: number) => void) => {
    ipcRenderer.on('switch-api-profile', (_event, direction: number) => callback(direction))
  },
  removeSwitchApiProfileListener: () => {
    ipcRenderer.removeAllListeners('switch-api-profile')
  },

  // Shortcut or toolbar asked to step to the next prompt scene
  onCycleScene: (callback: () => void) => {
    ipcRenderer.on('cycle-scene', () => callback())
  },
  removeCycleSceneListener: () => {
    ipcRenderer.removeAllListeners('cycle-scene')
  },

  // Shortcut or toolbar asked to show the other mode (截图 ↔ 对话)
  onSwitchMode: (callback: () => void) => {
    ipcRenderer.on('switch-mode', () => callback())
  },
  removeSwitchModeListener: () => {
    ipcRenderer.removeAllListeners('switch-mode')
  },

  // The menu bar icon's 「设置…」
  onOpenSettings: (callback: () => void) => {
    ipcRenderer.on('open-settings', () => callback())
  },
  removeOpenSettingsListener: () => {
    ipcRenderer.removeAllListeners('open-settings')
  },

  // 框选识别 showed its answer and the window holds the keyboard (true), or no longer
  onSnipSession: (callback: (active: boolean) => void) => {
    ipcRenderer.on('snip-session', (_event, active: boolean) => callback(active))
  },
  removeSnipSessionListener: () => {
    ipcRenderer.removeAllListeners('snip-session')
  },
  // Hide the window as the shortcut does, handing the keyboard back if it had it
  hideMainWindow: () => ipcRenderer.invoke('hideMainWindow'),

  // A screenshot was refused because this profile's model takes no images
  onVisionUnsupported: (callback: (profileId: string) => void) => {
    ipcRenderer.on('vision-unsupported', (_event, profileId: string) => callback(profileId))
  },
  removeVisionUnsupportedListener: () => {
    ipcRenderer.removeAllListeners('vision-unsupported')
  },

  // The active model refused 「关闭思考」, so its requests now go without it
  onThinkingUnsupported: (callback: (model: string) => void) => {
    ipcRenderer.on('thinking-unsupported', (_event, model: string) => callback(model))
  },
  removeThinkingUnsupportedListener: () => {
    ipcRenderer.removeAllListeners('thinking-unsupported')
  },

  // How long the finished request took, in milliseconds (measured in main)
  onSolutionDuration: (callback: (ms: number) => void) => {
    ipcRenderer.on('solution-duration', (_event, ms: number) => callback(ms))
  },
  removeSolutionDurationListener: () => {
    ipcRenderer.removeAllListeners('solution-duration')
  },

  // Listen for screenshot events
  onScreenshotTaken: (callback: (screenshotData: string) => void) => {
    ipcRenderer.on('screenshot-taken', (_event, screenshotData) => {
      callback(screenshotData)
    })
  },
  // Remove screenshot listener
  removeScreenshotListener: () => {
    ipcRenderer.removeAllListeners('screenshot-taken')
  },

  // Listen for solution chunks
  onSolutionChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('solution-chunk', (_event, chunk) => {
      callback(chunk)
    })
  },
  // Remove solution chunk listener
  removeSolutionChunkListener: () => {
    ipcRenderer.removeAllListeners('solution-chunk')
  },

  // Thinking models reason before they answer; those chunks render on their own
  onReasoningChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('reasoning-chunk', (_event, chunk) => {
      callback(chunk)
    })
  },
  removeReasoningChunkListener: () => {
    ipcRenderer.removeAllListeners('reasoning-chunk')
  },

  // A later request (appended screenshot, follow-up) starts a new reasoning
  // round, shown in its own block above its own answer
  onReasoningRoundStart: (callback: () => void) => {
    ipcRenderer.on('reasoning-round-start', callback)
  },
  removeReasoningRoundStartListener: () => {
    ipcRenderer.removeAllListeners('reasoning-round-start')
  },

  // Stop solution stream
  stopSolutionStream: () => ipcRenderer.invoke('stopSolutionStream'),

  // Send follow-up question
  sendFollowUpQuestion: (question: string) => ipcRenderer.invoke('sendFollowUpQuestion', question),

  // Listen for solution completion
  onSolutionComplete: (callback: () => void) => {
    ipcRenderer.on('solution-complete', callback)
  },
  removeSolutionCompleteListener: () => {
    ipcRenderer.removeAllListeners('solution-complete')
  },

  onSolutionStopped: (callback: () => void) => {
    ipcRenderer.on('solution-stopped', callback)
  },
  removeSolutionStoppedListener: () => {
    ipcRenderer.removeAllListeners('solution-stopped')
  },

  onSolutionError: (callback: (message: string) => void) => {
    ipcRenderer.on('solution-error', (_event, message) => {
      callback(message)
    })
  },
  removeSolutionErrorListener: () => {
    ipcRenderer.removeAllListeners('solution-error')
  },

  // Listen for scroll page up
  onScrollPageUp: (callback: () => void) => {
    ipcRenderer.on('scroll-page-up', callback)
  },
  // Remove scroll page up listener
  removeScrollPageUpListener: () => {
    ipcRenderer.removeAllListeners('scroll-page-up')
  },

  // Listen for screenshots-updated (gallery + the untruncated conversation total)
  onScreenshotsUpdated: (callback: (screenshots: string[], total: number) => void) => {
    ipcRenderer.on('screenshots-updated', (_event, screenshots, total) => {
      callback(screenshots, total)
    })
  },
  removeScreenshotsUpdatedListener: () => {
    ipcRenderer.removeAllListeners('screenshots-updated')
  },

  // Listen for scroll page down
  onScrollPageDown: (callback: () => void) => {
    ipcRenderer.on('scroll-page-down', callback)
  },
  // Remove scroll page down listener
  removeScrollPageDownListener: () => {
    ipcRenderer.removeAllListeners('scroll-page-down')
  },

  // AI loading events
  onAiLoadingStart: (callback: () => void) => {
    ipcRenderer.on('ai-loading-start', callback)
  },
  onAiLoadingEnd: (callback: () => void) => {
    ipcRenderer.on('ai-loading-end', callback)
  },
  removeAiLoadingStartListener: () => {
    ipcRenderer.removeAllListeners('ai-loading-start')
  },
  removeAiLoadingEndListener: () => {
    ipcRenderer.removeAllListeners('ai-loading-end')
  },

  // Solution clear event (new session)
  onSolutionClear: (callback: () => void) => {
    ipcRenderer.on('solution-clear', callback)
  },
  removeSolutionClearListener: () => {
    ipcRenderer.removeAllListeners('solution-clear')
  },

  // Connected screens, for picking which one to capture
  getDisplays: () => ipcRenderer.invoke('getDisplays') as Promise<DisplayOption[]>,
  // Cover every screen and let the user drag out the capture region; null if cancelled
  pickCaptureRegion: () => ipcRenderer.invoke('pickCaptureRegion') as Promise<CaptureRegion | null>,
  // Inside a picker window: its frozen screen, then report it painted, then the result
  getRegionPickerData: () =>
    ipcRenderer.invoke('getRegionPickerData') as Promise<RegionPickerData | null>,
  regionPickerReady: () => ipcRenderer.send('region-picker-ready'),
  finishRegionPicker: (rect: RegionRect | null) => ipcRenderer.send('finish-region-picker', rect),
  // A new capture region was picked (from any entry point); the store persists it
  onCaptureRegionPicked: (callback: (region: CaptureRegion) => void) => {
    ipcRenderer.on('capture-region-picked', (_event, region: CaptureRegion) => callback(region))
  },
  removeCaptureRegionPickedListener: () => {
    ipcRenderer.removeAllListeners('capture-region-picked')
  },
  // Select screenshot save directory
  selectScreenshotDir: () => ipcRenderer.invoke('selectScreenshotDir') as Promise<string | null>,
  // Select the directory the generated code is written to
  selectCodeDir: () => ipcRenderer.invoke('selectCodeDir') as Promise<string | null>,
  // Select the directory 对话模式's conversations are saved to
  selectConversationDir: () =>
    ipcRenderer.invoke('selectConversationDir') as Promise<string | null>,

  // 手机同步: whether the LAN page / relay connection is up, and the URLs for the QR codes
  getMobileStatus: () => ipcRenderer.invoke('mobile:get-status') as Promise<MobileSyncStatus>,
  // 对话模式: main owns the conversation, the page takes a snapshot and follows the events
  getConversationSnapshot: () =>
    ipcRenderer.invoke('conversation:get-snapshot') as Promise<ConversationSnapshot>,
  requestHint: () => ipcRenderer.invoke('conversation:request-hint'),
  stopHints: () => ipcRenderer.invoke('conversation:stop-hints'),
  clearConversation: () => ipcRenderer.invoke('conversation:clear'),
  onConversationUtterance: (callback: (utterance: Utterance) => void) => {
    ipcRenderer.on('conversation-utterance', (_event, utterance: Utterance) => callback(utterance))
  },
  onConversationUtteranceRemoved: (callback: (id: number) => void) => {
    ipcRenderer.on('conversation-utterance-removed', (_event, id: number) => callback(id))
  },
  onConversationHint: (callback: (card: HintCard) => void) => {
    ipcRenderer.on('conversation-hint', (_event, card: HintCard) => callback(card))
  },
  onConversationHintChunk: (callback: (id: number, chunk: string) => void) => {
    ipcRenderer.on('conversation-hint-chunk', (_event, id: number, chunk: string) =>
      callback(id, chunk)
    )
  },
  onConversationCleared: (callback: () => void) => {
    ipcRenderer.on('conversation-cleared', () => callback())
  },
  onConversationNotice: (callback: (message: string) => void) => {
    ipcRenderer.on('conversation-notice', (_event, message: string) => callback(message))
  },
  // Shortcut or toolbar asked to flip between automatic and manual hints
  onToggleHintMode: (callback: () => void) => {
    ipcRenderer.on('toggle-hint-mode', () => callback())
  },
  removeConversationListeners: () => {
    for (const channel of [
      'conversation-utterance',
      'conversation-utterance-removed',
      'conversation-hint',
      'conversation-hint-chunk',
      'conversation-cleared',
      'conversation-notice',
      'toggle-hint-mode'
    ]) {
      ipcRenderer.removeAllListeners(channel)
    }
  },

  // 资料库: main keeps the material on disk and puts it into each mode's system prompt
  listKnowledge: () => ipcRenderer.invoke('knowledge:list') as Promise<KnowledgeDoc[]>,
  getKnowledgeText: (id: string) => ipcRenderer.invoke('knowledge:get-text', id) as Promise<string>,
  // Open a file dialog and import what was picked; null if cancelled
  pickKnowledgeFiles: () =>
    ipcRenderer.invoke('knowledge:pick-files') as Promise<KnowledgeImportResult | null>,
  importKnowledgeFiles: (paths: string[]) =>
    ipcRenderer.invoke('knowledge:import-files', paths) as Promise<KnowledgeImportResult>,
  createKnowledge: (name: string, text: string) =>
    ipcRenderer.invoke('knowledge:create', name, text) as Promise<KnowledgeDoc>,
  updateKnowledge: (id: string, patch: KnowledgePatch) =>
    ipcRenderer.invoke('knowledge:update', id, patch) as Promise<KnowledgeDoc | null>,
  reimportKnowledge: (id: string) =>
    ipcRenderer.invoke('knowledge:reimport', id) as Promise<{ doc?: KnowledgeDoc; error?: string }>,
  removeKnowledge: (id: string) => ipcRenderer.invoke('knowledge:remove', id) as Promise<void>,
  // Where a dropped file lives on disk (`File.path` is gone since Electron 32)
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Transcription
  startTranscription: (apiKey: string, options?: TranscriptionOptions) =>
    ipcRenderer.invoke('start-transcription', apiKey, options),
  stopTranscription: () => ipcRenderer.invoke('stop-transcription'),
  sendTranscriptionAudioChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send('transcription-audio-chunk', chunk),
  getTranscriptionText: () => ipcRenderer.invoke('get-transcription-text') as Promise<string>,

  onToggleTranscription: (callback: () => void) => {
    ipcRenderer.on('toggle-transcription', callback)
  },
  removeToggleTranscriptionListener: () => {
    ipcRenderer.removeAllListeners('toggle-transcription')
  },
  onTranscriptionText: (callback: (data: { text: string; isPartial: boolean }) => void) => {
    ipcRenderer.on('transcription-text', (_event, data) => callback(data))
  },
  removeTranscriptionTextListener: () => {
    ipcRenderer.removeAllListeners('transcription-text')
  },
  onTranscriptionError: (callback: (message: string) => void) => {
    ipcRenderer.on('transcription-error', (_event, message) => callback(message))
  },
  removeTranscriptionErrorListener: () => {
    ipcRenderer.removeAllListeners('transcription-error')
  },
  onTranscriptionStopped: (callback: () => void) => {
    ipcRenderer.on('transcription-stopped', callback)
  },
  removeTranscriptionStoppedListener: () => {
    ipcRenderer.removeAllListeners('transcription-stopped')
  },
  onTranscriptionCleared: (callback: () => void) => {
    ipcRenderer.on('transcription-cleared', callback)
  },
  removeTranscriptionClearedListener: () => {
    ipcRenderer.removeAllListeners('transcription-cleared')
  }
}

export type MainAPI = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
