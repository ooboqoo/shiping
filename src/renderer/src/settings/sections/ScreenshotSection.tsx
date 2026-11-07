import { Camera, FileCode, SquareTerminal } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  useSettingsStore,
  type CodeNamingMode,
  type ScreenshotDisplay,
  type SnipMode
} from '@/lib/store/settings'
import { CaptureTargetFields } from '../CaptureTargetFields'
import { KnowledgeField } from '../KnowledgeField'
import { ModeProfileSelect } from '../ModeProfileSelect'
import { SceneEditor } from '../SceneEditor'
import { Field, SaveDirField, SettingsCard } from '../components'

export function ScreenshotSection({
  onEditProfile,
  onOpenKnowledge
}: {
  onEditProfile: (id: string) => void
  onOpenKnowledge: () => void
}) {
  const {
    screenshotDisplay,
    snipMode,
    screenshotAutoSave,
    screenshotDir,
    codeAutoSave,
    codeSaveDir,
    codeFileBaseName,
    codeNamingMode,
    codeCopyToClipboard,
    updateSetting
  } = useSettingsStore()

  // Mirrors save-code.ts: a blank or unusable name falls back to `Test`
  const baseNamePreview = codeFileBaseName.trim() || 'Test'

  return (
    <>
      <SettingsCard Icon={SquareTerminal} title="AI 与提示词">
        <div className="space-y-4">
          <ModeProfileSelect mode="screenshot" onEdit={onEditProfile} />
          <SceneEditor mode="screenshot" />
          <KnowledgeField mode="screenshot" onOpen={onOpenKnowledge} />
        </div>
      </SettingsCard>

      <SettingsCard Icon={Camera} title="截图">
        <div className="space-y-4">
          <CaptureTargetFields />

          <Field
            label="截图展示方式"
            note="主界面上截图占多大位置；无论选哪种，截图都会正常发送给 AI"
          >
            <Select
              value={screenshotDisplay}
              onValueChange={(val) => updateSetting('screenshotDisplay', val as ScreenshotDisplay)}
            >
              <SelectTrigger className="w-60 shrink-0 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不展示</SelectItem>
                <SelectItem value="count">卡片显示截图数量</SelectItem>
                <SelectItem value="gallery">显示全部缩略图（默认）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="框选后"
            note="框选识别和框选追加截图松开鼠标后做什么；按住 Shift 松开，这一次换成另一种。先输入问题时要打字，输入法的候选框不属于本工具的窗口，共享屏幕时可能被看到"
          >
            <Select
              value={snipMode}
              onValueChange={(val) => updateSetting('snipMode', val as SnipMode)}
            >
              <SelectTrigger className="w-60 shrink-0 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="send">直接发送（默认）</SelectItem>
                <SelectItem value="ask">先输入问题</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="保存截图到本地" note="开启后，每次截图都会自动保存到指定目录">
            <Switch
              className="scale-y-90"
              checked={screenshotAutoSave}
              onCheckedChange={(checked) => updateSetting('screenshotAutoSave', checked)}
            />
          </Field>
          {screenshotAutoSave && (
            <SaveDirField
              dir={screenshotDir}
              placeholder="默认: 图片/Shiping"
              pick={window.api.selectScreenshotDir}
              onChange={(dir) => updateSetting('screenshotDir', dir)}
            />
          )}
        </div>
      </SettingsCard>

      <SettingsCard Icon={FileCode} title="算法题保存到本地">
        <div className="space-y-4">
          <Field label="保存代码到本地" note="开启后，解答里包含代码时会按语言自动保存为源文件">
            <Switch
              className="scale-y-90"
              checked={codeAutoSave}
              onCheckedChange={(checked) => updateSetting('codeAutoSave', checked)}
            />
          </Field>
          {codeAutoSave && (
            <>
              <SaveDirField
                dir={codeSaveDir}
                placeholder="未选择目录（未选择时不会保存）"
                pick={window.api.selectCodeDir}
                onChange={(dir) => updateSetting('codeSaveDir', dir)}
              />

              <Field label="文件名" note="不含扩展名，扩展名按代码语言自动添加；留空则用 Test">
                <Input
                  value={codeFileBaseName}
                  onChange={(e) => updateSetting('codeFileBaseName', e.target.value)}
                  placeholder="Test"
                  className="h-9 w-60 shrink-0 bg-white"
                />
              </Field>

              <Field
                label="重名时"
                note={
                  codeNamingMode === 'overwrite'
                    ? '每次都写入同一个文件，会覆盖该目录下的同名文件'
                    : '依次命名为 ' + baseNamePreview + '1.java、' + baseNamePreview + '2.java 等'
                }
              >
                <Select
                  value={codeNamingMode}
                  onValueChange={(val) => updateSetting('codeNamingMode', val as CodeNamingMode)}
                >
                  <SelectTrigger className="w-60 shrink-0 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sequence">
                      依次编号（{baseNamePreview}1、{baseNamePreview}2）
                    </SelectItem>
                    <SelectItem value="overwrite">覆盖同一个文件（{baseNamePreview}）</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}

          <Field
            label="保存到剪贴板"
            note="开启后，解答里的代码会自动复制到剪贴板，可直接粘贴到编辑器"
          >
            <Switch
              className="scale-y-90"
              checked={codeCopyToClipboard}
              onCheckedChange={(checked) => updateSetting('codeCopyToClipboard', checked)}
            />
          </Field>
        </div>
      </SettingsCard>
    </>
  )
}
