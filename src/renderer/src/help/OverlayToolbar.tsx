import { PanelTop } from 'lucide-react'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { TOOLBAR_ACTIONS } from '@/lib/toolbar-actions'
import type { AppMode } from '@/lib/store/settings'
import { MODE_NAMES } from '@/lib/use-mode-page'
import { HelpSection } from './components'

export function OverlayToolbarHelp() {
  return (
    <HelpSection Icon={PanelTop} title="悬浮工具条" description="用鼠标点击替代快捷键操作">
      <p className="text-gray-700">
        工具条悬浮在主窗口正上方，跟随主窗口移动、随主窗口一起隐藏，透明度也与主窗口保持一致，
        并且和主窗口一样在共享屏幕时对方不可见。它主要用于两种场景：一是快捷键与考试/面试软件冲突或注册失败时，
        二是不希望通过键盘触发操作时。
      </p>
      {(['screenshot', 'conversation'] as const).map((mode) => (
        <ToolbarActions key={mode} mode={mode} />
      ))}
      <ul className="space-y-1 text-sm text-gray-700 list-disc list-inside">
        <li>点击按钮不会抢走焦点，做题页面不会失焦，光标也不会有明显的窗口切换动作。</li>
        <li>开启「鼠标穿透」后主窗口不再响应鼠标，但工具条仍然可以点击。</li>
        <li>工具条的按钮随模式变化：截图模式和对话模式各有一套，最后一个按钮用来切换模式。</li>
        <li>
          在「设置 → 界面与隐私 → 悬浮工具条」中可以按模式增减按钮，工具条宽度随按钮数量自动调整。
          下方标「默认不显示」的按钮需要在那里勾选后才会出现。
        </li>
        <li>
          在「设置 → 界面与隐私 →
          悬停触发」中可以改为：鼠标在按钮上停留一段时间即触发，全程不产生点击。
          停留过程中按钮下方会有进度条，中途移开即取消；触发后需移开再移回才会再次触发。
        </li>
        <li>
          隐藏/显示主窗口没有做成按钮：窗口隐藏后工具条也会一起隐藏，只能用快捷键唤回；
          对话模式的清空对话也没有，免得悬停时误触清掉整段对话。
        </li>
        <li>如不需要，可在「设置 → 界面与隐私 → 悬浮工具条」中关闭。</li>
      </ul>
    </HelpSection>
  )
}

function ToolbarActions({ mode }: { mode: AppMode }) {
  const { shortcuts } = useShortcutsStore()
  const actions = TOOLBAR_ACTIONS[mode]

  return (
    <div className="space-y-2">
      <h3 className="text-sm text-gray-500">{MODE_NAMES[mode]}</h3>
      <div className="overlay-toolbar w-fit">
        {actions
          .filter(({ defaultOn }) => defaultOn)
          .map(({ action, Icon }) => (
            <div key={action} className="flex size-7 items-center justify-center">
              <Icon className="size-4" />
            </div>
          ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {actions.map(({ action, Icon, label, defaultOn }) => (
          <div
            key={action}
            className="flex items-center gap-2 rounded border border-gray-400 px-2 py-1"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="text-sm">{label}</span>
            {!defaultOn && <span className="text-xs text-gray-500">默认不显示</span>}
            {shortcuts[action] && (
              <ShortcutRenderer shortcut={shortcuts[action].key} className="ml-auto select-none" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
