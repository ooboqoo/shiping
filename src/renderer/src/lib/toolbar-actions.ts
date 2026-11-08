import {
  ArrowDown,
  ArrowLeftRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Crop,
  Eraser,
  ImagePlus,
  Layers,
  Lightbulb,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MousePointer2,
  SquareDashedMousePointer,
  SquarePlus,
  Sun,
  SunDim,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { AppMode } from './store/settings'
import {
  MINI_BAR_LAYOUT,
  TOOLBAR_LAYOUT,
  toolbarActions,
  type ToolbarActionName,
  type ToolbarButtons
} from '../../../shared/toolbar'

export type { ToolbarActionName, ToolbarButtons }

export type ToolbarAction = {
  /** Also the shortcut action name, so the same key binding can be shown in help */
  action: ToolbarActionName
  Icon: LucideIcon
  label: string
  /** Shown until the user says otherwise */
  defaultOn: boolean
}

/** A label per mode where the same action means something else in each */
const DISPLAY: Record<
  ToolbarActionName,
  { Icon: LucideIcon; label: string | Record<AppMode, string> }
> = {
  takeScreenshot: { Icon: Camera, label: '截图解题（新开对话）' },
  snipScreenshot: { Icon: SquareDashedMousePointer, label: '框选识别（只截这一次）' },
  appendScreenshot: { Icon: ImagePlus, label: '追加截图' },
  snipAppendScreenshot: { Icon: SquarePlus, label: '框选追加截图' },
  pickCaptureRegion: { Icon: Crop, label: '设置截图区域' },
  stopSolutionStream: {
    Icon: CircleStop,
    label: { screenshot: '停止生成', conversation: '停止生成提示' }
  },
  ignoreOrEnableMouse: { Icon: MousePointer2, label: '切换鼠标穿透' },
  pageUp: { Icon: ChevronUp, label: '向上翻页' },
  pageDown: { Icon: ChevronDown, label: '向下翻页' },
  moveMainWindowUp: { Icon: ArrowUp, label: '向上移动窗口' },
  moveMainWindowLeft: { Icon: ArrowLeft, label: '向左移动窗口' },
  moveMainWindowDown: { Icon: ArrowDown, label: '向下移动窗口' },
  moveMainWindowRight: { Icon: ArrowRight, label: '向右移动窗口' },
  increaseOpacity: { Icon: Sun, label: '提高不透明度（更清晰）' },
  decreaseOpacity: { Icon: SunDim, label: '提高透明度（更透明）' },
  toggleTranscription: {
    Icon: Mic,
    label: { screenshot: '开始/暂停语音转录', conversation: '开始/停止监听对方说话' }
  },
  clearTranscription: { Icon: Eraser, label: '清除转录文本（不发给 AI）' },
  cycleScene: { Icon: Layers, label: '切换到下一个提示词场景' },
  generateHint: { Icon: Lightbulb, label: '立即出提示（没有新内容时换个说法重出）' },
  toggleHintMode: { Icon: Zap, label: '切换自动/手动出提示' },
  switchMode: {
    Icon: ArrowLeftRight,
    label: { screenshot: '切换到对话模式', conversation: '切换到截图模式' }
  },
  toggleMiniBar: {
    Icon: Minimize2,
    label: {
      screenshot: '收起为极简悬浮条（解答看手机）',
      conversation: '收起为极简悬浮条（提示看手机）'
    }
  }
}

function buildActions(mode: AppMode): ToolbarAction[] {
  return TOOLBAR_LAYOUT[mode].map(({ action, defaultOn }) => {
    const { Icon, label } = DISPLAY[action]
    return { action, Icon, label: typeof label === 'string' ? label : label[mode], defaultOn }
  })
}

/**
 * Every button a mode's toolbar can show, in display order (the list itself
 * lives in `shared/toolbar.ts`, where main reads it too). Drives the toolbar,
 * its settings and its help page section, so they never drift apart.
 */
export const TOOLBAR_ACTIONS: Record<AppMode, ToolbarAction[]> = {
  screenshot: buildActions('screenshot'),
  conversation: buildActions('conversation')
}

/** The buttons a mode's toolbar shows with the user's choice applied, in order */
export function shownToolbarActions(
  mode: AppMode,
  buttons: Partial<ToolbarButtons> | undefined
): ToolbarAction[] {
  const shown = new Set(toolbarActions(mode, buttons))
  return TOOLBAR_ACTIONS[mode].filter(({ action }) => shown.has(action))
}

/** Where the 极简悬浮条 says more than the toolbar's button does */
const MINI_BAR_DISPLAY: Partial<Record<ToolbarActionName, { Icon?: LucideIcon; label: string }>> = {
  pageUp: { label: '向上翻页（手机同步翻页）' },
  pageDown: { label: '向下翻页（手机同步翻页）' },
  toggleTranscription: { label: '开始/停止监听对方说话（监听中右上角有小圆点，停止时图标带斜线）' },
  toggleMiniBar: { Icon: Maximize2, label: '展开完整窗口' }
}

function buildMiniBarActions(mode: AppMode): ToolbarAction[] {
  return MINI_BAR_LAYOUT[mode].map((action) => {
    const { Icon, label } = DISPLAY[action]
    const own = MINI_BAR_DISPLAY[action]
    return {
      action,
      Icon: own?.Icon ?? Icon,
      label: own?.label ?? (typeof label === 'string' ? label : label[mode]),
      defaultOn: true
    }
  })
}

/**
 * The 极简悬浮条's buttons per mode, after its drag grip (the list itself is
 * `MINI_BAR_LAYOUT` in `shared/toolbar.ts`, where main checks its clicks).
 * Paging pages the phones too, for when an exam app swallows the shortcuts:
 * hover dwell then pages without a click.
 */
export const MINI_BAR_ACTIONS: Record<AppMode, ToolbarAction[]> = {
  screenshot: buildMiniBarActions('screenshot'),
  conversation: buildMiniBarActions('conversation')
}

/**
 * The microphone button of the toolbar and the 极简悬浮条. Kept quiet on
 * purpose, to be read by the user and not catch anyone else's eye: a slash
 * while not listening, a small dot while listening, a dim red dot when
 * recognition ended on an error. No colour fills, no animation (main.css)
 */
export function micButton(
  listening: boolean,
  failed: boolean
): { Icon: LucideIcon; className: string } {
  if (listening) return { Icon: Mic, className: 'mic-listening' }
  return { Icon: MicOff, className: failed ? 'mic-off mic-failed' : 'mic-off' }
}
