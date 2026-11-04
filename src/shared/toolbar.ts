import type { AppMode } from './api-profile'

/** Shortcut actions the overlay toolbar can carry as buttons */
export type ToolbarActionName =
  | 'takeScreenshot'
  | 'snipScreenshot'
  | 'appendScreenshot'
  | 'snipAppendScreenshot'
  | 'pickCaptureRegion'
  | 'stopSolutionStream'
  | 'ignoreOrEnableMouse'
  | 'pageUp'
  | 'pageDown'
  | 'moveMainWindowUp'
  | 'moveMainWindowLeft'
  | 'moveMainWindowDown'
  | 'moveMainWindowRight'
  | 'increaseOpacity'
  | 'decreaseOpacity'
  | 'toggleTranscription'
  | 'clearTranscription'
  | 'cycleScene'
  | 'generateHint'
  | 'toggleHintMode'
  | 'switchMode'

/**
 * The buttons the user turned on or off, per mode. One left out keeps its
 * default, so a button added in a later version arrives as it was meant to.
 */
export type ToolbarButtons = Record<AppMode, Partial<Record<ToolbarActionName, boolean>>>

export type ToolbarSlot = { action: ToolbarActionName; defaultOn: boolean }

const on = (action: ToolbarActionName): ToolbarSlot => ({ action, defaultOn: true })
const off = (action: ToolbarActionName): ToolbarSlot => ({ action, defaultOn: false })

/** In both modes, after each mode's own buttons */
const COMMON_SLOTS: ToolbarSlot[] = [
  on('ignoreOrEnableMouse'),
  on('pageUp'),
  on('pageDown'),
  on('moveMainWindowUp'),
  on('moveMainWindowLeft'),
  on('moveMainWindowDown'),
  on('moveMainWindowRight'),
  on('increaseOpacity'),
  on('decreaseOpacity')
]

/**
 * Every button each mode's toolbar can show, in display order; the user picks
 * which of them it does. Main builds the window's width from it and accepts a
 * click only on the buttons of the mode on screen; the renderer adds icons and
 * labels (`lib/toolbar-actions.ts`).
 *
 * `hideOrShowMainWindow` is not offered: hiding the window also hides the
 * toolbar, leaving no way to click the window back. Nor is 对话模式's
 * 清空对话 (its `clearTranscription`): a hover-triggered button must not be
 * able to wipe the conversation. 截图模式's only drops text not yet sent.
 */
export const TOOLBAR_LAYOUT: Record<AppMode, readonly ToolbarSlot[]> = {
  screenshot: [
    on('takeScreenshot'),
    off('snipScreenshot'),
    on('appendScreenshot'),
    off('snipAppendScreenshot'),
    on('pickCaptureRegion'),
    on('stopSolutionStream'),
    ...COMMON_SLOTS,
    on('toggleTranscription'),
    off('clearTranscription'),
    on('cycleScene'),
    on('switchMode')
  ],
  conversation: [
    on('generateHint'),
    on('toggleHintMode'),
    on('stopSolutionStream'),
    on('toggleTranscription'),
    ...COMMON_SLOTS,
    on('cycleScene'),
    on('switchMode')
  ]
}

export const createToolbarButtons = (): ToolbarButtons => ({ screenshot: {}, conversation: {} })

/** The buttons a mode's toolbar shows, in order. Never none */
export function toolbarActions(
  mode: AppMode,
  buttons: Partial<ToolbarButtons> | undefined
): ToolbarActionName[] {
  const layout = TOOLBAR_LAYOUT[mode]
  const choice = buttons?.[mode] ?? {}
  const shown = layout.filter((slot) => choice[slot.action] ?? slot.defaultOn)
  // The settings page keeps one on; a hand-edited store could still turn all off
  return (shown.length > 0 ? shown : layout.filter((slot) => slot.defaultOn)).map(
    (slot) => slot.action
  )
}

/** Only booleans for buttons that still exist, whatever was stored */
export function normalizeToolbarButtons(value: unknown): ToolbarButtons {
  const result = createToolbarButtons()
  if (!value || typeof value !== 'object') return result
  for (const mode of ['screenshot', 'conversation'] as const) {
    const saved = (value as Record<string, unknown>)[mode]
    if (!saved || typeof saved !== 'object') continue
    for (const { action } of TOOLBAR_LAYOUT[mode]) {
      const shown = (saved as Record<string, unknown>)[action]
      if (typeof shown === 'boolean') result[mode][action] = shown
    }
  }
  return result
}

// Mirrors `.overlay-toolbar` in main.css: `p-2` around `size-7` buttons with `gap-0.5`
const BAR_PADDING = 8
const BUTTON_SIZE = 28
const BUTTON_GAP = 2

/** The toolbar window's height: one row of buttons */
export const TOOLBAR_HEIGHT = 44

/** The toolbar window's width for this many buttons, exactly; 16 buttons make 494 */
export function toolbarWidth(buttonCount: number): number {
  const count = Math.max(1, buttonCount)
  return BAR_PADDING * 2 + count * BUTTON_SIZE + (count - 1) * BUTTON_GAP
}
