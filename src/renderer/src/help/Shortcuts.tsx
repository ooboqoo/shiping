import { Keyboard } from 'lucide-react'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { HelpSection } from './components'

export function Shortcuts() {
  return (
    <HelpSection
      Icon={Keyboard}
      title="快捷键"
      description="快捷键是操作应用的主要方式，您可以在设置中自定义快捷键。"
    >
      <ShortcutItemGroup category="Window Management" />
      <ShortcutItemGroup category="Screenshot" />
      <ShortcutItemGroup category="Conversation" />
      <ShortcutItemGroup category="AI" />
      <ShortcutItemGroup category="Navigation" />
      <ShortcutItemGroup category="Window Movement" />
    </HelpSection>
  )
}

function ShortcutItemGroup({ category }: { category: string }) {
  const { shortcuts } = useShortcutsStore()
  return (
    <div className="space-y-2">
      <h3 className="text-sm text-gray-500">{getCategoryName(category)}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Object.values(shortcuts)
          .filter((shortcut) => shortcut.category === category)
          .map((shortcut, index) => (
            <ShortcutItem key={index} action={shortcut.action} shortcutKey={shortcut.key} />
          ))}
      </div>
    </div>
  )
}

function ShortcutItem({ action, shortcutKey }: { action: string; shortcutKey: string }) {
  return (
    <div className="flex items-center justify-between rounded border border-gray-400 px-2 py-1">
      <span className="text-sm">{getShortcutDescription(action)}</span>
      <ShortcutRenderer shortcut={shortcutKey} className="select-none" />
    </div>
  )
}

const getCategoryName = (category: string) => {
  const categoryMap: Record<string, string> = {
    'Window Management': '窗口管理',
    Screenshot: '截图模式',
    Conversation: '对话模式',
    AI: '两种模式通用（作用于当前模式）',
    Navigation: '页面导航',
    'Window Movement': '窗口移动'
  }
  return categoryMap[category] || category
}

const getShortcutDescription = (action: string) => {
  const descriptionMap: Record<string, string> = {
    hideOrShowMainWindow: '隐藏/显示窗口',
    switchMode: '切换截图模式 / 对话模式',
    ignoreOrEnableMouse: '鼠标穿透(窗口对鼠标隐身)',
    increaseOpacity: '提高不透明度(窗口更清晰)',
    decreaseOpacity: '提高透明度(窗口更透明)',
    takeScreenshot: '截图并生成解题建议（会新开对话）',
    snipScreenshot: '框选一块区域截图并生成解题建议（只截这一次，也可以先输入问题）',
    appendScreenshot: '追加截图并生成解题建议',
    snipAppendScreenshot: '框选一块区域追加到当前对话（只截这一次，也可以先输入问题）',
    pickCaptureRegion: '设置截图区域（之后只截这块）',
    generateHint: '立即出提示（没有新内容时换个说法重出）',
    toggleHintMode: '切换自动/手动出提示',
    stopSolutionStream: '停止生成（解答或提示）',
    previousApiProfile: '当前模式切换到上一个 AI 配置',
    nextApiProfile: '当前模式切换到下一个 AI 配置',
    cycleScene: '切换到当前模式的下一个提示词场景',
    toggleTranscription: '语音转录 / 对话模式的监听：开始或停止',
    clearTranscription: '清除转录文本 / 对话模式：清空对话',
    pageUp: '向上翻页',
    pageDown: '向下翻页',
    moveMainWindowUp: '向上移动窗口',
    moveMainWindowDown: '向下移动窗口',
    moveMainWindowLeft: '向左移动窗口',
    moveMainWindowRight: '向右移动窗口'
  }
  return descriptionMap[action] || action
}
