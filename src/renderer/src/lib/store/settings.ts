import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import codingPrompt from './prompts/coding.md?raw'
import englishExamPrompt from './prompts/english-exam.md?raw'
import aptitudeTestPrompt from './prompts/aptitude-test.md?raw'
import generalQaPrompt from './prompts/general-qa.md?raw'
import techInterviewPrompt from './prompts/tech-interview.md?raw'
import behavioralInterviewPrompt from './prompts/behavioral-interview.md?raw'
import englishInterviewPrompt from './prompts/english-interview.md?raw'
import { DEFAULT_THEME, type Theme } from '../theme'
import {
  knownVision,
  normalizeBaseURL,
  resolveLinkedModel,
  type ModelSwitchReason
} from '../providers'
import { createProfile, type ApiProfile } from '../api-profiles'
import type { CaptureRegion } from '../../../../shared/capture-region'
import type { AppMode } from '../../../../shared/api-profile'
import type { HintMode } from '../../../../shared/conversation'
import { DEFAULT_PROXY, normalizeProxySettings, type ProxySettings } from '../../../../shared/proxy'

export type { Theme }
export type { ApiProfile }
export type { AppMode, HintMode }

export interface PromptScene {
  id: string
  name: string
  prompt: string
  isPreset: boolean
  /** The mode the scene belongs to; scenes saved before modes existed are 截图模式 ones */
  mode?: AppMode
}

export const CODING_SCENE_ID = 'coding'

/** Default prompts for all preset scenes, maintained as Markdown files under ./prompts */
export const PRESET_SCENE_PROMPTS: Record<string, string> = {
  'general-qa': generalQaPrompt,
  [CODING_SCENE_ID]: codingPrompt,
  'english-exam': englishExamPrompt,
  'aptitude-test': aptitudeTestPrompt,
  'tech-interview': techInterviewPrompt,
  'behavioral-interview': behavioralInterviewPrompt,
  'english-interview': englishInterviewPrompt
}

export function sceneMode(scene: PromptScene): AppMode {
  return scene.mode ?? 'screenshot'
}

// A mode's first scene is the one a new install starts on, and the one it falls
// back to when its active scene is gone
const createPresetScenes = (): PromptScene[] => [
  {
    id: 'general-qa',
    name: '通用问答',
    prompt: PRESET_SCENE_PROMPTS['general-qa'],
    isPreset: true
  },
  {
    id: CODING_SCENE_ID,
    name: '解算法题',
    prompt: PRESET_SCENE_PROMPTS[CODING_SCENE_ID],
    isPreset: true
  },
  {
    id: 'english-exam',
    name: '英语考试',
    prompt: PRESET_SCENE_PROMPTS['english-exam'],
    isPreset: true
  },
  {
    id: 'aptitude-test',
    name: '能力测评',
    prompt: PRESET_SCENE_PROMPTS['aptitude-test'],
    isPreset: true
  },
  {
    id: 'tech-interview',
    name: '技术面试',
    prompt: PRESET_SCENE_PROMPTS['tech-interview'],
    isPreset: true,
    mode: 'conversation'
  },
  {
    id: 'behavioral-interview',
    name: '行为面试',
    prompt: PRESET_SCENE_PROMPTS['behavioral-interview'],
    isPreset: true,
    mode: 'conversation'
  },
  {
    id: 'english-interview',
    name: '英文面试',
    prompt: PRESET_SCENE_PROMPTS['english-interview'],
    isPreset: true,
    mode: 'conversation'
  }
]

/**
 * The scene list: the presets the user has not deleted, in their fixed order
 * and keeping edited prompts, then the user's own. A preset added in a later
 * version is not in `removed`, so it still reaches existing users.
 */
function assembleScenes(saved: PromptScene[], removed: string[]): PromptScene[] {
  return [
    ...createPresetScenes()
      .filter((p) => !removed.includes(p.id))
      .map((p) => {
        const kept = saved.find((s) => s.id === p.id)
        // An emptied prompt stays empty; a restored preset is not in `saved`, so
        // it gets its default back. Its mode always comes from the table, never
        // from the saved copy
        return kept ? { ...kept, mode: p.mode } : p
      }),
    ...saved.filter((s) => !s.isPreset)
  ]
}

/**
 * Derive a mode's system prompt from its active scene: `customPrompt` for
 * 截图模式, `conversationPrompt` for 对话模式, both read by the main process
 */
function composePrompt(scenes: PromptScene[], sceneId: string, mode: AppMode): string {
  const scene = scenes.find((s) => s.id === sceneId && sceneMode(s) === mode)
  // An emptied scene, preset or not, sends no prompt; 「恢复默认」 brings a preset's back.
  // The active id always names a scene of its mode (`merge` sees to it on load)
  return scene?.prompt.trim() ?? ''
}

/** The store keys holding a mode's active scene and the prompt derived from it */
const SCENE_KEYS = {
  screenshot: { sceneId: 'activeSceneId', prompt: 'customPrompt' },
  conversation: { sceneId: 'conversationSceneId', prompt: 'conversationPrompt' }
} as const

/** Both modes' prompts, recomputed after any change to the scene list */
function composePrompts(
  scenes: PromptScene[],
  activeSceneId: string,
  conversationSceneId: string
): { customPrompt: string; conversationPrompt: string } {
  return {
    customPrompt: composePrompt(scenes, activeSceneId, 'screenshot'),
    conversationPrompt: composePrompt(scenes, conversationSceneId, 'conversation')
  }
}

/** Whether any of a mode's preset scenes was deleted and can be restored */
export function hasRemovedPresets(removedIds: string[], mode: AppMode): boolean {
  return scenesOf(createPresetScenes(), mode).some((p) => removedIds.includes(p.id))
}

/** A mode's scenes, in list order */
export function scenesOf(scenes: PromptScene[], mode: AppMode): PromptScene[] {
  return scenes.filter((s) => sceneMode(s) === mode)
}

/** `captureScreen` value for capturing whichever screen the mouse is on */
export const CAPTURE_SCREEN_CURSOR = 'cursor'

/** How captured screenshots are shown on the main page, ordered by how much room they take */
export type ScreenshotDisplay = 'none' | 'count' | 'gallery'

/** What to do when a saved code file would collide with an existing one */
export type CodeNamingMode = 'sequence' | 'overwrite'

/** Immutably replace one profile, leaving the rest untouched */
function patchProfile(
  profiles: ApiProfile[],
  id: string,
  patch: Partial<Omit<ApiProfile, 'id'>>
): ApiProfile[] {
  return profiles.map((p) => (p.id === id ? { ...p, ...withVision(p, patch) } : p))
}

/**
 * When a patch changes a profile's model, what is known about its image input
 * no longer applies: start over from the preset table (the settings page then
 * refines it from the platform's model list)
 */
function withVision(
  profile: ApiProfile | undefined,
  patch: Partial<Omit<ApiProfile, 'id'>>
): Partial<Omit<ApiProfile, 'id'>> {
  if (patch.model === undefined || patch.model === profile?.model || 'vision' in patch) return patch
  return { ...patch, vision: knownVision(patch.model) }
}

/** The live fields that are a mirror of the active profile */
const CREDENTIAL_KEYS = ['apiBaseURL', 'apiKey', 'apiHeaders', 'model', 'disableThinking'] as const

/** Same as `patchProfile`, but a no-op when `id` matches nothing */
function patchActiveProfile(
  profiles: ApiProfile[],
  id: string,
  patch: Partial<Omit<ApiProfile, 'id'>>
): ApiProfile[] {
  return profiles.some((p) => p.id === id) ? patchProfile(profiles, id, patch) : profiles
}

export const OPACITY_MIN = 0.1
export const OPACITY_MAX = 1
export const OPACITY_STEP = 0.05

interface Settings {
  networkProxy: ProxySettings
  /** Window colour scheme; `light` is a white background with dark text */
  theme: Theme
  /** Saved AI endpoints; the one being edited is mirrored onto the fields below */
  apiProfiles: ApiProfile[]
  /**
   * Which entry of `apiProfiles` the settings page edits. Not the one in use:
   * each mode picks its own (`screenshotProfileId` / `conversationProfileId`)
   */
  activeProfileId: string
  /** The profile 截图模式 sends screenshots with; its model should take images */
  screenshotProfileId: string
  /** The profile 对话模式 asks for hints with; text only, so a fast model suits it */
  conversationProfileId: string
  /**
   * Whether the user has ever saved an API key. The welcome dialog keys off
   * this rather than the live `apiKey`, so switching to a profile that is still
   * blank does not pop the dialog back up over what the user is doing.
   */
  hasConfiguredApi: boolean
  apiBaseURL: string
  /** API Base URL entries the user created from the picker, kept as a shortcut list */
  customBaseURLs: string[]
  apiKey: string
  /** Extra request headers, one `Name: Value` per line */
  apiHeaders: string
  model: string
  /** The active profile's 「关闭思考」 */
  disableThinking: boolean
  /** Custom models created before they were kept per API Base URL; offered for every URL */
  customModels: string[]
  /** Custom models the user created, keyed by normalized API Base URL */
  customModelsByBaseURL: Record<string, string[]>
  /** Last model used with each normalized API Base URL, restored when switching back */
  modelByBaseURL: Record<string, string>
  /** 截图模式's system prompt, derived from `activeSceneId` */
  customPrompt: string
  /** 对话模式's system prompt, derived from `conversationSceneId` */
  conversationPrompt: string

  scenes: PromptScene[]
  /** 截图模式's scene (the name predates 对话模式) */
  activeSceneId: string
  conversationSceneId: string
  /** Preset scenes the user deleted; kept so the next load does not bring them back */
  removedPresetSceneIds: string[]

  opacity: number
  /** Allow resizing the main window and overlay toolbar */
  resizable: boolean
  /** Show the click-through overlay toolbar above the main window */
  showOverlayToolbar: boolean
  /** 隐藏主页面底部的快捷键提醒文字 */
  hideShortcutHints: boolean
  /** Dwell time in ms before hovering a toolbar button fires it; 0 disables hover triggering */
  toolbarHoverDelay: number
  /** How the captured screenshots are shown above the solution */
  screenshotDisplay: ScreenshotDisplay
  /** 截取哪块屏幕：`cursor` 跟随鼠标，其余为固定屏幕的 `Display.id` */
  captureScreen: string
  /** 只截取某块屏幕上的这块区域；为 null 时截取整个屏幕 */
  captureRegion: CaptureRegion | null

  screenshotAutoSave: boolean
  screenshotDir: string

  /** 把 AI 生成的代码自动保存为源文件（算法题解答） */
  codeAutoSave: boolean
  /** 代码保存目录；为空时不保存 */
  codeSaveDir: string
  /** 保存代码时的文件名（不含扩展名）；为空时用默认的 Test */
  codeFileBaseName: string
  /** 重名时：sequence 依次编号（Test1、Test2），overwrite 覆盖同一个文件 */
  codeNamingMode: CodeNamingMode
  /** 把 AI 生成的代码自动复制到系统剪贴板 */
  codeCopyToClipboard: boolean

  dashscopeApiKey: string

  /** 手机同步 over the LAN: the app serves the phone page itself */
  mobileLanEnabled: boolean
  /** The LAN page's secret, made on first use; a new one voids every QR code */
  mobileLanKey: string
  /** 手机同步 through relay/server.mjs on a public server */
  mobileRelayEnabled: boolean
  mobileRelayURL: string
  /** The server's RELAY_KEY */
  mobileRelayKey: string

  /** Hide app windows from screenshots and screen sharing */
  stealthEnabled: boolean
  hideDockIcon: boolean
  /** No tray icon (macOS menu bar, Windows notification area) */
  hideTrayIcon: boolean

  audioInputDeviceId: string
  audioOutputDeviceId: string

  /** The mode shown last, restored on the next start */
  lastMode: AppMode
  /** 对话模式: hint as soon as the other side finishes a sentence, or only on the shortcut */
  conversationHintMode: HintMode
  /** 对话模式: silence (ms) after which the recogniser ends a sentence; shorter hints sooner */
  conversationSilenceMs: number
  /** 对话模式: a finished sentence shorter than this (punctuation aside) triggers no automatic hint */
  conversationMinChars: number
  /** 对话模式: hide the transcript column to give the hints the whole window */
  conversationTranscriptHidden: boolean
  /** 对话模式: 把每段对话自动保存为 Markdown 文件 */
  conversationAutoSave: boolean
  /** 对话记录保存目录；为空时用 文档/Shiping */
  conversationSaveDir: string
}

/** A model change made on the user's behalf when the API Base URL changed */
export interface ModelSwitch {
  from: string
  to: string
  reason: ModelSwitchReason
}

interface SettingsStore extends Settings {
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  /** Change the API Base URL and carry the model over to the new platform's spelling */
  setApiBaseURL: (url: string) => ModelSwitch | null
  /** Change the model, remembering it for the current API Base URL */
  setModel: (model: string) => void
  /** Switch to another saved profile, carrying the live fields with it */
  setActiveProfile: (id: string) => void
  /** Add a profile, either blank or copied from the active one */
  addProfile: (name: string, copyActive?: boolean) => string
  /** Rename a profile */
  renameProfile: (id: string, name: string) => void
  /** Update one field of a profile; keeps the live fields in sync when it is active */
  updateProfile: (id: string, patch: Partial<Omit<ApiProfile, 'id'>>) => void
  /** Remove a profile; refuses to remove the last one */
  removeProfile: (id: string) => boolean
  /** Make a mode send its requests with this profile */
  setModeProfile: (mode: AppMode, id: string) => void
  /**
   * Step a mode to its next profile, for the keyboard shortcut. 截图模式 skips
   * the ones known not to take images. Null when there is nothing to step to.
   */
  cycleProfile: (mode: AppMode, step?: number) => ApiProfile | null
  /** Record that an API key has been saved, so the welcome dialog stays away */
  markApiConfigured: () => void
  /**
   * Change one of the live credential fields, keeping the active profile's
   * own copy in step. Every settings-page input must go through this rather
   * than `updateSetting`, otherwise the edit lives only in the flat fields and
   * is lost the moment the user switches profiles or restarts.
   */
  updateCredential: (patch: Partial<Pick<ApiProfile, (typeof CREDENTIAL_KEYS)[number]>>) => void
  addCustomModel: (baseURL: string, model: string) => void
  removeCustomModel: (baseURL: string, model: string) => void
  /** Step the window opacity within [OPACITY_MIN, OPACITY_MAX] */
  adjustOpacity: (delta: number) => void
  syncSettings: (settings: Partial<Settings>) => void
  /** Make a scene its mode's active one */
  setActiveScene: (id: string) => void
  /** Step a mode to its next scene, wrapping at the end, and report its name */
  cycleScene: (mode: AppMode) => string
  updateScenePrompt: (id: string, prompt: string) => void
  addScene: (name: string, mode: AppMode) => string
  /** Delete a scene, preset or not; refuses to delete the last one of its mode */
  removeScene: (id: string) => boolean
  /** Bring back a mode's deleted preset scenes, with their default prompts */
  restorePresetScenes: (mode: AppMode) => void
}

const defaultSettings: Settings = {
  networkProxy: { ...DEFAULT_PROXY },
  theme: DEFAULT_THEME,
  // Seeded on rehydrate; the id must exist up front so the active profile resolves
  apiProfiles: [],
  activeProfileId: 'profile-default',
  // Filled in on rehydrate: both start out on the profile being edited
  screenshotProfileId: '',
  conversationProfileId: '',
  hasConfiguredApi: false,
  apiBaseURL: '',
  customBaseURLs: [],
  apiKey: '',
  apiHeaders: '',
  model: '',
  disableThinking: false,
  customModels: [],
  customModelsByBaseURL: {},
  modelByBaseURL: {},
  // Filled in on rehydrate: each mode starts on its first scene
  customPrompt: '',
  conversationPrompt: '',
  scenes: createPresetScenes(),
  activeSceneId: '',
  conversationSceneId: '',
  removedPresetSceneIds: [],

  opacity: 0.8,
  resizable: true,
  showOverlayToolbar: true,
  hideShortcutHints: false,
  toolbarHoverDelay: 1000,
  screenshotDisplay: 'gallery',
  captureScreen: CAPTURE_SCREEN_CURSOR,
  captureRegion: null,

  screenshotAutoSave: false,
  screenshotDir: '',

  codeAutoSave: false,
  codeSaveDir: '',
  codeFileBaseName: 'Test',
  codeNamingMode: 'sequence',
  codeCopyToClipboard: false,

  dashscopeApiKey: '',

  mobileLanEnabled: false,
  mobileLanKey: '',
  mobileRelayEnabled: false,
  mobileRelayURL: '',
  mobileRelayKey: '',

  stealthEnabled: true,
  hideDockIcon: false,
  hideTrayIcon: false,

  audioInputDeviceId: '',
  audioOutputDeviceId: '',

  lastMode: 'screenshot',
  conversationHintMode: 'auto',
  conversationSilenceMs: 800,
  conversationMinChars: 4,
  conversationTranscriptHidden: false,
  conversationAutoSave: false,
  conversationSaveDir: ''
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      updateSetting: (key, value) => {
        set({ [key]: value })
        // Setting a key from anywhere in the UI means the user is set up, so
        // the welcome dialog stays away from then on (see `hasConfiguredApi`)
        if (key === 'apiKey' && typeof value === 'string' && value.trim()) {
          set({ hasConfiguredApi: true })
        }
      },
      setApiBaseURL: (url) => {
        const state = get()
        const from = normalizeBaseURL(state.apiBaseURL)
        const to = normalizeBaseURL(url)
        if (from === to) {
          set({ apiBaseURL: url })
          return null
        }
        const modelByBaseURL = { ...state.modelByBaseURL }
        if (state.model) modelByBaseURL[from] = state.model
        const linked = resolveLinkedModel({
          model: state.model,
          baseURL: to,
          remembered: modelByBaseURL[to],
          customModels: state.customModelsByBaseURL[to] ?? []
        })
        const model = linked?.model ?? state.model
        if (model) modelByBaseURL[to] = model
        set({
          apiBaseURL: url,
          model,
          modelByBaseURL,
          apiProfiles: patchActiveProfile(state.apiProfiles, state.activeProfileId, {
            apiBaseURL: url,
            model
          })
        })
        return linked && linked.model !== state.model
          ? { from: state.model, to: linked.model, reason: linked.reason }
          : null
      },
      setModel: (model) => {
        set((state) => {
          const key = normalizeBaseURL(state.apiBaseURL)
          const modelByBaseURL = { ...state.modelByBaseURL }
          if (model) modelByBaseURL[key] = model
          else delete modelByBaseURL[key]
          // The active profile owns the value, so keep it in step
          return {
            model,
            modelByBaseURL,
            apiProfiles: patchActiveProfile(state.apiProfiles, state.activeProfileId, { model })
          }
        })
      },
      setActiveProfile: (id) => {
        set((state) => {
          const profile = state.apiProfiles.find((p) => p.id === id)
          if (!profile) return {}
          // Restore the profile's own model spelling for its platform
          return {
            activeProfileId: id,
            apiBaseURL: profile.apiBaseURL,
            apiKey: profile.apiKey,
            apiHeaders: profile.apiHeaders,
            model: profile.model,
            disableThinking: profile.disableThinking
          }
        })
      },
      addProfile: (name, copyActive = false) => {
        const state = get()
        const source = copyActive
          ? state.apiProfiles.find((p) => p.id === state.activeProfileId)
          : undefined
        const profile = createProfile({
          name,
          apiBaseURL: source?.apiBaseURL ?? '',
          apiKey: source?.apiKey ?? '',
          apiHeaders: source?.apiHeaders ?? '',
          model: source?.model ?? '',
          disableThinking: source?.disableThinking ?? false,
          vision: source?.vision
        })
        // Only opened for editing: which profile each mode uses is left alone
        set({
          apiProfiles: [...state.apiProfiles, profile],
          activeProfileId: profile.id,
          apiBaseURL: profile.apiBaseURL,
          apiKey: profile.apiKey,
          apiHeaders: profile.apiHeaders,
          model: profile.model,
          disableThinking: profile.disableThinking
        })
        return profile.id
      },
      renameProfile: (id, name) => {
        set((state) => ({
          apiProfiles: patchProfile(state.apiProfiles, id, { name })
        }))
      },
      updateProfile: (id, patch) => {
        set((state) => {
          const apiProfiles = patchProfile(state.apiProfiles, id, patch)
          // Any key saved anywhere means the user is set up
          const configured =
            state.hasConfiguredApi ||
            (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '')
          // The active profile is mirrored onto the live fields the main
          // process reads, so editing it must update those too
          if (id !== state.activeProfileId) return { apiProfiles, hasConfiguredApi: configured }
          return {
            apiProfiles,
            hasConfiguredApi: configured,
            ...(patch.apiBaseURL !== undefined ? { apiBaseURL: patch.apiBaseURL } : {}),
            ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
            ...(patch.apiHeaders !== undefined ? { apiHeaders: patch.apiHeaders } : {}),
            ...(patch.model !== undefined ? { model: patch.model } : {}),
            ...(patch.disableThinking !== undefined
              ? { disableThinking: patch.disableThinking }
              : {})
          }
        })
      },
      removeProfile: (id) => {
        const state = get()
        if (state.apiProfiles.length <= 1) return false
        const index = state.apiProfiles.findIndex((p) => p.id === id)
        if (index === -1) return false

        const apiProfiles = state.apiProfiles.filter((p) => p.id !== id)
        // A mode that used it hands over to its neighbour
        const next = apiProfiles[Math.min(index, apiProfiles.length - 1)]
        const modeProfiles = {
          screenshotProfileId:
            state.screenshotProfileId === id ? next.id : state.screenshotProfileId,
          conversationProfileId:
            state.conversationProfileId === id ? next.id : state.conversationProfileId
        }
        if (id !== state.activeProfileId) {
          set({ apiProfiles, ...modeProfiles })
          return true
        }
        // Removing the one being edited opens its neighbour instead
        set({
          apiProfiles,
          ...modeProfiles,
          activeProfileId: next.id,
          apiBaseURL: next.apiBaseURL,
          apiKey: next.apiKey,
          apiHeaders: next.apiHeaders,
          model: next.model,
          disableThinking: next.disableThinking
        })
        return true
      },
      setModeProfile: (mode, id) => {
        if (!get().apiProfiles.some((p) => p.id === id)) return
        set(mode === 'screenshot' ? { screenshotProfileId: id } : { conversationProfileId: id })
      },
      cycleProfile: (mode, step = 1) => {
        const state = get()
        const currentId =
          mode === 'screenshot' ? state.screenshotProfileId : state.conversationProfileId
        // Stepping onto a profile that cannot read screenshots would only fail
        const candidates = state.apiProfiles.filter(
          (p) => mode !== 'screenshot' || p.vision !== false || p.id === currentId
        )
        if (candidates.length < 2) return null
        const index = Math.max(
          0,
          candidates.findIndex((p) => p.id === currentId)
        )
        const count = candidates.length
        const next = candidates[(((index + step) % count) + count) % count]
        get().setModeProfile(mode, next.id)
        return next
      },
      markApiConfigured: () => {
        if (!get().hasConfiguredApi) set({ hasConfiguredApi: true })
      },
      updateCredential: (patch) => {
        set((state) => {
          const configured =
            state.hasConfiguredApi ||
            (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '')
          return {
            ...patch,
            hasConfiguredApi: configured,
            apiProfiles: patchActiveProfile(state.apiProfiles, state.activeProfileId, patch)
          }
        })
      },
      addCustomModel: (baseURL, model) => {
        set((state) => {
          const key = normalizeBaseURL(baseURL)
          const list = state.customModelsByBaseURL[key] ?? []
          if (list.includes(model) || state.customModels.includes(model)) return {}
          return {
            customModelsByBaseURL: { ...state.customModelsByBaseURL, [key]: [...list, model] }
          }
        })
      },
      removeCustomModel: (baseURL, model) => {
        set((state) => {
          const key = normalizeBaseURL(baseURL)
          const customModelsByBaseURL = { ...state.customModelsByBaseURL }
          const list = (customModelsByBaseURL[key] ?? []).filter((m) => m !== model)
          if (list.length > 0) customModelsByBaseURL[key] = list
          else delete customModelsByBaseURL[key]
          return {
            customModels: state.customModels.filter((m) => m !== model),
            customModelsByBaseURL
          }
        })
      },
      adjustOpacity: (delta) => {
        const raw = get().opacity + delta
        // Round to 2 decimals to avoid float drift across repeated presses
        const opacity = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(raw * 100) / 100))
        set({ opacity })
      },
      syncSettings: (settings) => {
        set(settings)
        // Credentials filled in from main (.env) belong to the active profile too
        const credentials = Object.fromEntries(
          CREDENTIAL_KEYS.filter((key) => settings[key] !== undefined).map((key) => [
            key,
            settings[key]
          ])
        )
        if (Object.keys(credentials).length > 0) get().updateCredential(credentials)
      },
      setActiveScene: (id) => {
        set((state) => {
          const scene = state.scenes.find((s) => s.id === id)
          if (!scene) return {}
          const mode = sceneMode(scene)
          const keys = SCENE_KEYS[mode]
          return { [keys.sceneId]: id, [keys.prompt]: composePrompt(state.scenes, id, mode) }
        })
      },
      cycleScene: (mode) => {
        const state = get()
        const scenes = scenesOf(state.scenes, mode)
        if (scenes.length === 0) return ''
        const activeId = state[SCENE_KEYS[mode].sceneId]
        // An unknown active id starts over from the first scene
        const next = scenes[(scenes.findIndex((s) => s.id === activeId) + 1) % scenes.length]
        get().setActiveScene(next.id)
        return next.name
      },
      updateScenePrompt: (id, prompt) => {
        set((state) => {
          const scenes = state.scenes.map((s) => (s.id === id ? { ...s, prompt } : s))
          return {
            scenes,
            ...composePrompts(scenes, state.activeSceneId, state.conversationSceneId)
          }
        })
      },
      addScene: (name, mode) => {
        const id = `custom-${Date.now()}`
        set((state) => {
          const scenes = [...state.scenes, { id, name, prompt: '', isPreset: false, mode }]
          const keys = SCENE_KEYS[mode]
          return { scenes, [keys.sceneId]: id, [keys.prompt]: composePrompt(scenes, id, mode) }
        })
        return id
      },
      removeScene: (id) => {
        const state = get()
        const removed = state.scenes.find((s) => s.id === id)
        if (!removed) return false
        const mode = sceneMode(removed)
        const siblings = scenesOf(state.scenes, mode)
        // One must remain per mode, or there is nothing to pick and no prompt to edit
        if (siblings.length <= 1) return false

        const scenes = state.scenes.filter((s) => s.id !== id)
        const keys = SCENE_KEYS[mode]
        // Removing the active scene hands over to its neighbour in the same mode
        const index = siblings.findIndex((s) => s.id === id)
        const remaining = siblings.filter((s) => s.id !== id)
        const activeId =
          state[keys.sceneId] === id
            ? remaining[Math.min(index, remaining.length - 1)].id
            : state[keys.sceneId]
        set({
          scenes,
          [keys.sceneId]: activeId,
          [keys.prompt]: composePrompt(scenes, activeId, mode),
          // Presets are rebuilt on every load, so a deleted one must be remembered
          ...(removed.isPreset
            ? { removedPresetSceneIds: [...state.removedPresetSceneIds, id] }
            : {})
        })
        return true
      },
      restorePresetScenes: (mode) => {
        set((state) => {
          const presetIds = new Set(scenesOf(createPresetScenes(), mode).map((s) => s.id))
          const removedPresetSceneIds = state.removedPresetSceneIds.filter(
            (id) => !presetIds.has(id)
          )
          const scenes = assembleScenes(state.scenes, removedPresetSceneIds)
          return {
            scenes,
            removedPresetSceneIds,
            ...composePrompts(scenes, state.activeSceneId, state.conversationSceneId)
          }
        })
      }
    }),
    {
      // From before the rename to 识屏; a new key would lose everyone's settings
      name: 'interview-coder-settings',
      version: 8,
      migrate: (persisted, version) => {
        const state = persisted as Partial<Settings>
        // Drop the legacy codeLanguage field (language now lives in the prompt text)
        delete (state as Record<string, unknown>).codeLanguage
        if (version < 8) {
          // Hover-delay options are now 0.5s / 1s / 2s; snap the retired ones
          // so the Select still matches an item
          if (state.toolbarHoverDelay === 800 || state.toolbarHoverDelay === 1200) {
            state.toolbarHoverDelay = 1000
          }
        }
        if (version < 5) {
          // Convert the legacy free-form customPrompt into a custom scene
          const scenes = createPresetScenes()
          let activeSceneId = CODING_SCENE_ID
          const legacyPrompt = (state.customPrompt ?? '').trim()
          if (legacyPrompt) {
            const id = `custom-${Date.now()}`
            scenes.push({ id, name: '自定义场景', prompt: legacyPrompt, isPreset: false })
            activeSceneId = id
          }
          return { ...state, scenes, activeSceneId }
        }
        return state
      },
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<Settings>) }
        try {
          state.networkProxy = normalizeProxySettings(state.networkProxy)
        } catch {
          state.networkProxy = { ...DEFAULT_PROXY }
        }
        // Rebuild the presets on every load, so ones added in a later version
        // show up for existing users; the ones the user deleted stay out
        const persistedScenes = Array.isArray(state.scenes) ? state.scenes : []
        state.removedPresetSceneIds = Array.isArray(state.removedPresetSceneIds)
          ? state.removedPresetSceneIds
          : []
        state.scenes = assembleScenes(persistedScenes, state.removedPresetSceneIds)
        for (const mode of ['screenshot', 'conversation'] as const) {
          // Deleting refuses a mode's last scene, but a hand-edited store could
          // still arrive without any; its presets are the only sensible offer then
          if (scenesOf(state.scenes, mode).length === 0) {
            const presetIds = new Set(scenesOf(createPresetScenes(), mode).map((s) => s.id))
            state.removedPresetSceneIds = state.removedPresetSceneIds.filter(
              (id) => !presetIds.has(id)
            )
            state.scenes = assembleScenes(persistedScenes, state.removedPresetSceneIds)
          }
          const key = SCENE_KEYS[mode].sceneId
          const scenes = scenesOf(state.scenes, mode)
          if (!scenes.some((s) => s.id === state[key])) state[key] = scenes[0].id
        }
        Object.assign(
          state,
          composePrompts(state.scenes, state.activeSceneId, state.conversationSceneId)
        )
        state.apiProfiles = reconcileApiProfiles(state)
        // Before modes existed the profile being edited was the one in use
        for (const key of ['screenshotProfileId', 'conversationProfileId'] as const) {
          if (!state.apiProfiles.some((p) => p.id === state[key])) {
            state[key] =
              key === 'conversationProfileId' && state.screenshotProfileId
                ? state.screenshotProfileId
                : state.activeProfileId
          }
        }
        return state
      }
    }
  )
)

/**
 * Keep the profile list and the live API fields consistent after a rehydrate.
 *
 * Runs on every load, which covers all the cases at once: a fresh install (no
 * profiles yet), an upgrade from a version that had only the flat fields (adopt
 * them as the first profile, so nobody loses the key they already entered), and
 * an ordinary load (trust the stored list).
 */
function reconcileApiProfiles(state: Settings): ApiProfile[] {
  // Profiles saved before custom headers, the thinking switch or the image
  // flag existed carry none of them
  const profiles = (Array.isArray(state.apiProfiles) ? state.apiProfiles : []).map((p) => ({
    ...p,
    apiHeaders: p.apiHeaders ?? '',
    disableThinking: p.disableThinking ?? false,
    vision: p.vision ?? knownVision(p.model ?? '')
  }))
  const active = profiles.find((p) => p.id === state.activeProfileId)

  if (profiles.length === 0) {
    const seeded: ApiProfile = {
      id: state.activeProfileId || 'profile-default',
      name: '配置1',
      apiBaseURL: state.apiBaseURL ?? '',
      apiKey: state.apiKey ?? '',
      apiHeaders: state.apiHeaders ?? '',
      model: state.model ?? '',
      disableThinking: false,
      vision: knownVision(state.model ?? '')
    }
    state.activeProfileId = seeded.id
    state.hasConfiguredApi = !!seeded.apiKey.trim()
    return [seeded]
  }

  if (!active) {
    // The stored active id points nowhere (removed by hand, or restored from a
    // backup): fall back to the first profile rather than leaving nothing set
    const first = profiles[0]
    state.activeProfileId = first.id
    state.apiBaseURL = first.apiBaseURL
    state.apiKey = first.apiKey
    state.apiHeaders = first.apiHeaders
    state.model = first.model
    state.disableThinking = first.disableThinking
    state.hasConfiguredApi = hasAnyApiKey(profiles)
    return profiles
  }

  // Upgrades from before this flag existed: any saved key counts as configured,
  // so an existing user is never met by the welcome dialog again
  state.hasConfiguredApi = state.hasConfiguredApi || hasAnyApiKey(profiles)

  // The active profile owns the credentials and the flat fields are its mirror
  // — the ones the main process reads to send requests and take screenshots.
  // The profile wins, so the stored URL / key / model come back on restart.
  const resolved = {
    apiBaseURL: active.apiBaseURL || state.apiBaseURL,
    apiKey: active.apiKey || state.apiKey,
    model: active.model || state.model
  }
  state.apiBaseURL = resolved.apiBaseURL
  state.apiKey = resolved.apiKey
  state.model = resolved.model
  // Headers and the thinking switch came in with profiles, so no flat value
  // predates them to adopt
  state.apiHeaders = active.apiHeaders
  state.disableThinking = active.disableThinking

  // A profile saved before these fields existed adopts whatever the flat
  // fields held, so an upgrade never silently blanks the user's credentials
  const needsSeeding =
    active.apiBaseURL !== resolved.apiBaseURL ||
    active.apiKey !== resolved.apiKey ||
    active.model !== resolved.model

  return needsSeeding ? patchProfile(profiles, active.id, resolved) : profiles
}

/** Whether at least one profile has a usable API key */
function hasAnyApiKey(profiles: ApiProfile[]): boolean {
  return profiles.some((p) => (p.apiKey ?? '').trim() !== '')
}
