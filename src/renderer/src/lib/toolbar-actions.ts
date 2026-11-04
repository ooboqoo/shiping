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
  Mic,
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
