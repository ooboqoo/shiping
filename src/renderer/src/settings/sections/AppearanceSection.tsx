import { Palette, Shield } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSettingsStore, OPACITY_MIN, OPACITY_MAX, OPACITY_STEP } from '@/lib/store/settings'
import { useAppStore } from '@/lib/store/app'
import type { Theme } from '@/lib/theme'
import { isMac } from '@/lib/utils/env'
import { Field, SettingsCard } from '../components'

const trayIconLabel = isMac ? '隐藏状态栏图标' : '隐藏托盘图标'
const trayIconPlace = isMac ? '屏幕顶部状态栏' : '任务栏右下角'

export function AppearanceSection() {
  const {
    theme,
    opacity,
    resizable,
    showOverlayToolbar,
    hideShortcutHints,
    toolbarHoverDelay,
    stealthEnabled,
    hideDockIcon,
    hideTrayIcon,
    updateSetting
  } = useSettingsStore()
  const { ignoreMouse } = useAppStore()

  return (
    <>
      <SettingsCard Icon={Palette} title="界面">
        <div className="space-y-4">
          <Field
            label="背景主题"
            note="做题页面为白色背景时选「浅色」，工具会变为白底黑字，不再显眼"
          >
            <Select value={theme} onValueChange={(val) => updateSetting('theme', val as Theme)}>
              <SelectTrigger className="w-60 shrink-0 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">深色（默认）</SelectItem>
                <SelectItem value="light">浅色（白底黑字）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="窗口透明度" note="拖动可实时预览效果，也可在主界面用快捷键调节">
            <div className="w-60 shrink-0 flex items-center gap-2">
              <span className="text-xs whitespace-nowrap">透明</span>
              <Slider
                min={OPACITY_MIN}
                max={OPACITY_MAX}
                step={OPACITY_STEP}
                value={[opacity]}
                onValueChange={(value) => {
                  updateSetting('opacity', value[0])
                  document.body.style.opacity = value[0].toString()
                }}
              />
              <span className="text-xs whitespace-nowrap">不透明</span>
            </div>
          </Field>

          <Field label="允许调整主窗口大小" note="关闭后鼠标移到窗口边缘不再出现缩放光标">
            <Switch
              className="scale-y-90"
              checked={resizable}
              onCheckedChange={(checked) => updateSetting('resizable', checked)}
            />
          </Field>

          <Field label="隐藏快捷键提醒" note="开启后，主界面底部不再显示各操作的快捷键">
            <Switch
              className="scale-y-90"
              checked={hideShortcutHints}
              onCheckedChange={(checked) => updateSetting('hideShortcutHints', checked)}
            />
          </Field>

          <Field
            label="鼠标穿透"
            note="开启后鼠标点击会穿到窗口背后，可直接操作背后的编辑器；不需要悬浮工具条也能使用"
          >
            <Switch
              className="scale-y-90"
              checked={ignoreMouse}
              onCheckedChange={(checked) => {
                void window.api.setIgnoreMouse(checked)
              }}
            />
          </Field>

          <Field
            label="悬浮工具条"
            note="在主窗口上方显示一排按钮，可用鼠标点击替代快捷键操作，按钮随模式变化，详见帮助中心"
          >
            <Switch
              className="scale-y-90"
              checked={showOverlayToolbar}
              onCheckedChange={(checked) => updateSetting('showOverlayToolbar', checked)}
            />
          </Field>

          {showOverlayToolbar && (
            <Field
              className="pl-4 border-l-2 border-gray-400/70"
              label="悬停触发"
              note="鼠标在按钮上停留指定时间即触发，无需点击；停留过程中按钮下方有进度条"
            >
              <Select
                value={String(toolbarHoverDelay)}
                onValueChange={(val) => updateSetting('toolbarHoverDelay', Number(val))}
              >
                <SelectTrigger className="w-60 shrink-0 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">关闭（仅点击触发）</SelectItem>
                  <SelectItem value="500">停留 0.5 秒</SelectItem>
                  <SelectItem value="1000">停留 1 秒</SelectItem>
                  <SelectItem value="2000">停留 2 秒</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
      </SettingsCard>

      <SettingsCard Icon={Shield} title="隐私">
        <div className="flex flex-col gap-5">
          <Field
            label="隐身模式"
            note="默认开启，在截图和屏幕共享中隐藏窗口；关闭后可正常截图和共享，立即生效"
            noteLayout="stacked"
          >
            <Switch
              aria-label="隐身模式"
              checked={stealthEnabled}
              onCheckedChange={(checked) => updateSetting('stealthEnabled', checked)}
            />
          </Field>
          {isMac && (
            <Field
              label="隐藏 Dock 图标"
              note="开启后不在程序坞和 Cmd+Tab 切换器中显示，可通过快捷键或状态栏图标唤起窗口"
              noteLayout="stacked"
            >
              <Switch
                aria-label="隐藏 Dock 图标"
                checked={hideDockIcon}
                onCheckedChange={(checked) => updateSetting('hideDockIcon', checked)}
              />
            </Field>
          )}
          <Field
            label={trayIconLabel}
            note={`单击${trayIconPlace}的图标即可框选识别，右键可显示/隐藏窗口、打开设置或退出；共享整个屏幕时对方能看到这个图标，介意可隐藏`}
            noteLayout="stacked"
          >
            <Switch
              aria-label={trayIconLabel}
              checked={hideTrayIcon}
              onCheckedChange={(checked) => updateSetting('hideTrayIcon', checked)}
            />
          </Field>
          <p className="text-xs font-light leading-relaxed">
            图片和语音仅发送到您配置的 AI 或语音识别平台，不经过识屏的服务器。
          </p>
        </div>
      </SettingsCard>
    </>
  )
}
