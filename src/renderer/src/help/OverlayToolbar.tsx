import { PanelTop } from 'lucide-react'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { MINI_BAR_ACTIONS, TOOLBAR_ACTIONS, type ToolbarAction } from '@/lib/toolbar-actions'
import { MODE_NAMES } from '@/lib/use-mode-page'
import { HelpSection } from './components'

export function OverlayToolbarHelp() {
  return (
    <HelpSection Icon={PanelTop} title="悬浮工具条" description="用鼠标点击替代快捷键操作">
      <p className="text-gray-700">
        工具条悬浮在主窗口正上方，跟随主窗口移动、随主窗口一起隐藏，透明度也与主窗口保持一致，
        并且和主窗口一样受隐身模式保护（是否生效同样要自己测试）。它主要用于两种场景：一是快捷键与考试/面试软件冲突或注册失败时，
        二是不希望通过键盘触发操作时。
      </p>
      {(['screenshot', 'conversation'] as const).map((mode) => (
        <ToolbarActions key={mode} title={MODE_NAMES[mode]} actions={TOOLBAR_ACTIONS[mode]} />
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
      {(['screenshot', 'conversation'] as const).map((mode) => (
        <ToolbarActions
          key={mode}
          title={`极简悬浮条 · ${MODE_NAMES[mode]}`}
          actions={MINI_BAR_ACTIONS[mode]}
        />
      ))}
      <ul className="space-y-1 text-sm text-gray-700 list-disc list-inside">
        <li>
          配合「手机同步」使用：解答和提示在手机上看，电脑屏幕上只留一个小悬浮条，主窗口和上面的工具条都收起来。
          悬浮条和主窗口一样在共享屏幕时对方不可见，点击同样不抢焦点。
        </li>
        <li>
          从工具条的收起按钮、快捷键或「设置 →
          手机同步」进入，停留在当前模式，对话模式的监听不会中断；点悬浮条最右边的按钮或再按一次快捷键展开。
        </li>
        <li>
          翻页按钮同时翻动手机上的内容。考试/面试软件占用了快捷键时，配合「悬停触发」不用点击、也不用碰手机就能翻页。
        </li>
        <li>
          对话模式下麦克风图标带斜线表示没在监听；手机上的「对话提示」页同样会显示监听状态和出错原因。
        </li>
        <li>
          按住左侧的把手可以拖动悬浮条，「移动窗口」快捷键此时也移动悬浮条；位置在本次运行期间会记住。
        </li>
        <li>悬浮条显示时，「隐藏/显示窗口」快捷键隐藏/显示的是悬浮条。</li>
      </ul>
    </HelpSection>
  )
}

function ToolbarActions({ title, actions }: { title: string; actions: ToolbarAction[] }) {
  const { shortcuts } = useShortcutsStore()

  return (
    <div className="space-y-2">
      <h3 className="text-sm text-gray-500">{title}</h3>
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
