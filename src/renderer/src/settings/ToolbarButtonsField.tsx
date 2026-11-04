import { Checkbox } from '@/components/ui/checkbox'
import { useSettingsStore, type AppMode } from '@/lib/store/settings'
import { TOOLBAR_ACTIONS, shownToolbarActions } from '@/lib/toolbar-actions'
import { MODE_NAMES } from '@/lib/use-mode-page'

const MODES: AppMode[] = ['screenshot', 'conversation']

/** Which buttons each mode's toolbar shows; the window's width follows */
export function ToolbarButtonsField() {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">
        显示的按钮
        <span className="ml-2 text-xs font-light">
          两种模式各选各的，工具条宽度随按钮数量自动调整；每种模式至少保留一个
        </span>
      </div>
      {MODES.map((mode) => (
        <ModeButtons key={mode} mode={mode} />
      ))}
    </div>
  )
}

function ModeButtons({ mode }: { mode: AppMode }) {
  const toolbarButtons = useSettingsStore((state) => state.toolbarButtons)
  const setToolbarButton = useSettingsStore((state) => state.setToolbarButton)
  const resetToolbarButtons = useSettingsStore((state) => state.resetToolbarButtons)

  const shown = new Set(shownToolbarActions(mode, toolbarButtons).map(({ action }) => action))
  const isDefault = TOOLBAR_ACTIONS[mode].every(
    ({ action, defaultOn }) => shown.has(action) === defaultOn
  )

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{MODE_NAMES[mode]}</span>
        <span className="text-gray-600">{shown.size} 个按钮</span>
        {!isDefault && (
          <button
            className="ml-auto text-blue-700 hover:underline cursor-pointer"
            onClick={() => resetToolbarButtons(mode)}
          >
            恢复默认
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {TOOLBAR_ACTIONS[mode].map(({ action, Icon, label }) => {
          const on = shown.has(action)
          // The last one stays: no toolbar at all is the switch above
          const locked = on && shown.size === 1
          return (
            <label
              key={action}
              className="flex min-w-0 items-center gap-2 py-0.5 text-sm has-[:disabled]:opacity-60"
            >
              <Checkbox
                className="bg-white"
                checked={on}
                disabled={locked}
                onCheckedChange={(checked) => setToolbarButton(mode, action, checked === true)}
              />
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{label}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
