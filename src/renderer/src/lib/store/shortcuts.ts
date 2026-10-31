import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isMac, platformAlt } from '../utils/env'

export type Shortcut = {
  action: string
  key: string
  defaultKey: string
  category: string
  status?: ShortcutStatus
}

export enum ShortcutStatus {
  Registered = 'registered',
  Failed = 'failed',
  /** Shortcut is available to register but not registered. */
  Available = 'available'
}

interface ShortcutsState {
  shortcuts: Record<string, Shortcut>
}

interface ShortcutsStore extends ShortcutsState {
  updateShortcut: (action: string, shortcut: Shortcut) => void
  updateShortcuts: (shortcuts: Record<string, Shortcut>) => void
  resetShortcuts: () => void
}

type PersistedShortcutsState = {
  shortcuts?: Record<string, Shortcut>
}

function isPersistedShortcutsState(value: unknown): value is PersistedShortcutsState {
  return typeof value === 'object' && value !== null && 'shortcuts' in value
}

/**
 * Categories: `Window Management`, `Screenshot` (截图模式 only), `Conversation`
 * (对话模式 only), `AI` (acts on whichever mode is on screen), `Navigation`,
 * `Window Movement`. The category comes from here even for stored bindings.
 */
const defaultShortcuts: Record<string, Omit<Shortcut, 'defaultKey'>> = {
  hideOrShowMainWindow: {
    action: 'hideOrShowMainWindow',
    key: `${platformAlt}+H`,
    category: 'Window Management'
  },
  switchMode: {
    action: 'switchMode',
    key: `${platformAlt}+Shift+M`,
    category: 'Window Management'
  },
  ignoreOrEnableMouse: {
    action: 'ignoreOrEnableMouse',
    key: `${platformAlt}+M`,
    category: 'Window Management'
  },
  increaseOpacity: {
    action: 'increaseOpacity',
    key: `${platformAlt}+Shift+Up`,
    category: 'Window Management'
  },
  decreaseOpacity: {
    action: 'decreaseOpacity',
    key: `${platformAlt}+Shift+Down`,
    category: 'Window Management'
  },
  takeScreenshot: {
    action: 'takeScreenshot',
    key: `${platformAlt}+Enter`,
    category: 'Screenshot'
  },
  snipScreenshot: {
    action: 'snipScreenshot',
    // Not Ctrl+Shift+S on Windows: that is 另存为 nearly everywhere, and this key
    // stays held while the window is hidden
    key: isMac ? 'Alt+Shift+S' : 'CommandOrControl+Alt+S',
    category: 'Screenshot'
  },
  appendScreenshot: {
    action: 'appendScreenshot',
    key: `${platformAlt}+Shift+Enter`,
    category: 'Screenshot'
  },
  pickCaptureRegion: {
    action: 'pickCaptureRegion',
    key: `${platformAlt}+Shift+R`,
    category: 'Screenshot'
  },
  generateHint: {
    action: 'generateHint',
    key: `${platformAlt}+G`,
    category: 'Conversation'
  },
  toggleHintMode: {
    action: 'toggleHintMode',
    key: `${platformAlt}+Shift+G`,
    category: 'Conversation'
  },
  stopSolutionStream: {
    action: 'stopSolutionStream',
    key: `${platformAlt}+.`,
    category: 'AI'
  },
  previousApiProfile: {
    action: 'previousApiProfile',
    key: `${platformAlt}+[`,
    category: 'AI'
  },
  nextApiProfile: {
    action: 'nextApiProfile',
    key: `${platformAlt}+]`,
    category: 'AI'
  },
  cycleScene: {
    action: 'cycleScene',
    key: `${platformAlt}+Shift+P`,
    category: 'AI'
  },
  toggleTranscription: {
    action: 'toggleTranscription',
    key: `${platformAlt}+T`,
    category: 'AI'
  },
  clearTranscription: {
    action: 'clearTranscription',
    key: `${platformAlt}+Shift+T`,
    category: 'AI'
  },
  pageUp: { action: 'pageUp', key: 'CommandOrControl+J', category: 'Navigation' },
  pageDown: { action: 'pageDown', key: 'CommandOrControl+K', category: 'Navigation' },
  moveMainWindowUp: {
    action: 'moveMainWindowUp',
    key: 'CommandOrControl+Up',
    category: 'Window Movement'
  },
  moveMainWindowDown: {
    action: 'moveMainWindowDown',
    key: 'CommandOrControl+Down',
    category: 'Window Movement'
  },
  moveMainWindowLeft: {
    action: 'moveMainWindowLeft',
    key: 'CommandOrControl+Left',
    category: 'Window Movement'
  },
  moveMainWindowRight: {
    action: 'moveMainWindowRight',
    key: 'CommandOrControl+Right',
    category: 'Window Movement'
  }
}

export const useShortcutsStore = create<ShortcutsStore>()(
  persist(
    (set) => ({
      shortcuts: Object.fromEntries(
        Object.entries(defaultShortcuts).map(([action, shortcut]) => [
          action,
          { ...shortcut, defaultKey: shortcut.key }
        ])
      ),
      updateShortcut: (action, shortcut) => {
        set((state) => ({
          shortcuts: {
            ...state.shortcuts,
            [action]: shortcut
          }
        }))
      },
      updateShortcuts: (shortcuts) => {
        set({ shortcuts })
      },
      resetShortcuts: () => {
        set({
          shortcuts: Object.fromEntries(
            Object.entries(defaultShortcuts).map(([action, shortcut]) => [
              action,
              { ...shortcut, defaultKey: shortcut.key }
            ])
          )
        })
      }
    }),
    {
      // From before the rename to 识屏; a new key would lose everyone's bindings
      name: 'interview-coder-shortcuts',
      version: 5,
      migrate: (state: unknown, version: number) => {
        if (!isPersistedShortcutsState(state) || !state.shortcuts) return state as ShortcutsStore
        // Merge in any new default shortcuts that are missing
        const defaults = Object.fromEntries(
          Object.entries(defaultShortcuts).map(([action, shortcut]) => [
            action,
            { ...shortcut, defaultKey: shortcut.key }
          ])
        )
        const merged = {
          ...state,
          shortcuts: {
            ...defaults,
            ...state.shortcuts
          }
        } as ShortcutsStore

        // v2→v3: On Windows, migrate Alt shortcuts to CommandOrControl (Ctrl).
        // Only the stored ones: a default may use Alt on purpose (框选识别's Ctrl+Alt+S)
        if (version < 3 && !isMac) {
          for (const action of Object.keys(state.shortcuts)) {
            const shortcut = merged.shortcuts[action]
            if (!shortcut?.key) continue
            merged.shortcuts[action] = {
              ...shortcut,
              key: shortcut.key.replace(/\bAlt\b/g, 'CommandOrControl'),
              defaultKey: shortcut.defaultKey.replace(/\bAlt\b/g, 'CommandOrControl')
            }
          }
        }

        return merged
      },
      merge: (persisted, current) => {
        const state = persisted as PersistedShortcutsState
        const stored = state?.shortcuts ?? {}
        // Shortcuts added after this user last saved must still appear, so the
        // defaults are the floor and the stored bindings win on top of them.
        // `merge` runs on every rehydrate, unlike `migrate` which only runs
        // when the version changes. Stored actions that no longer exist are dropped.
        // Only the key is the user's: the category and default follow the code,
        // so regrouping the actions reaches existing users too. An empty key is
        // one the user cleared, and stays cleared
        const shortcuts = { ...current.shortcuts }
        for (const [action, shortcut] of Object.entries(stored)) {
          if (shortcuts[action] && typeof shortcut?.key === 'string') {
            shortcuts[action] = { ...shortcuts[action], key: shortcut.key }
          }
        }
        return { ...current, shortcuts }
      }
    }
  )
)
