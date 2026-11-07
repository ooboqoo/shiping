import type { ConversationAudioMode } from '../../../../shared/conversation'
import { FileText, Lightbulb, MessagesSquare, TriangleAlert } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSettingsStore, type HintMode } from '@/lib/store/settings'
import { KnowledgeField } from '../KnowledgeField'
import { ModeProfileSelect } from '../ModeProfileSelect'
import { SceneEditor } from '../SceneEditor'
import { Advanced, Field, SaveDirField, SettingsCard } from '../components'

/** Silence that ends a sentence; the recogniser's own default is 1300ms */
const SILENCE_OPTIONS = [
  { value: 500, label: '0.5 秒（最快，可能把一句切成两句）' },
  { value: 800, label: '0.8 秒（默认）' },
  { value: 1200, label: '1.2 秒（稳，适合说话慢的对方）' },
  { value: 1600, label: '1.6 秒（很稳）' }
]

const MIN_CHARS_OPTIONS = [2, 4, 6, 8]

export function ConversationSection({
  onEditProfile,
  onOpenVoice,
  onOpenKnowledge
}: {
  onEditProfile: (id: string) => void
  onOpenVoice: () => void
  onOpenKnowledge: () => void
}) {
  const {
    dashscopeApiKey,
    conversationContextEnabled,
    conversationContextRounds,
    conversationContextTokenBudget,
    conversationAudioMode,
    conversationHintMode,
    conversationSilenceMs,
    conversationMinChars,
    conversationTranscriptHidden,
    conversationAutoSave,
    conversationSaveDir,
    updateSetting
  } = useSettingsStore()

  return (
    <>
      {!dashscopeApiKey && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-600/40 bg-amber-100/80 px-4 py-2 text-sm text-amber-900">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          对话模式靠语音识别听对方说话，需要先填写百炼平台 API Key
          <button
            className="ml-auto text-blue-700 hover:underline cursor-pointer"
            onClick={onOpenVoice}
          >
            去填写
          </button>
        </div>
      )}

      <SettingsCard Icon={MessagesSquare} title="AI 与提示词">
        <div className="space-y-4">
          <ModeProfileSelect mode="conversation" onEdit={onEditProfile} />
          <SceneEditor mode="conversation" />
          <KnowledgeField mode="conversation" onOpen={onOpenKnowledge} />
        </div>
      </SettingsCard>

      <SettingsCard Icon={MessagesSquare} title="摘要上下文与双路录音">
        <div className="space-y-4">
          <Field
            label="加载摘要上下文"
            note="仅加载最近几轮已完成的摘要，当前问题完整发送；后台压缩不阻塞新问题，未完成的摘要暂时跳过"
          >
            <Switch
              aria-label="加载摘要上下文"
              checked={conversationContextEnabled}
              onCheckedChange={(checked) => updateSetting('conversationContextEnabled', checked)}
            />
          </Field>
          <Field
            label="历史轮数"
            note="默认最近 3 轮；一轮为面试官问题与对应 AI 建议。我的实际发言另行标注"
          >
            <input
              aria-label="历史轮数"
              type="number"
              min={1}
              max={20}
              value={conversationContextRounds}
              disabled={!conversationContextEnabled}
              onChange={(e) =>
                updateSetting(
                  'conversationContextRounds',
                  Math.min(20, Math.max(1, Number(e.target.value) || 1))
                )
              }
              className="w-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm disabled:opacity-50"
            />
          </Field>
          <Field
            label="历史摘要预算"
            note="约估 token，默认 1000，限制全部历史背景，不截断当前问题；越大可能增加首字等待"
          >
            <input
              aria-label="历史摘要预算"
              type="number"
              min={100}
              max={4000}
              step={100}
              value={conversationContextTokenBudget}
              disabled={!conversationContextEnabled}
              onChange={(e) =>
                updateSetting(
                  'conversationContextTokenBudget',
                  Math.min(4000, Math.max(100, Number(e.target.value) || 100))
                )
              }
              className="w-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm disabled:opacity-50"
            />
          </Field>
          <Field
            label="对话录音来源"
            note="默认同时录入电脑声音与麦克风，分别识别；只有电脑声音自动触发提示。改变后重新开始监听。双路会增加语音识别用量；建议戴耳机避免重复收音"
          >
            <Select
              value={conversationAudioMode}
              onValueChange={(value) =>
                updateSetting('conversationAudioMode', value as ConversationAudioMode)
              }
            >
              <SelectTrigger className="w-60 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dual">电脑声音 + 我的麦克风（默认）</SelectItem>
                <SelectItem value="system">仅电脑声音</SelectItem>
                <SelectItem value="microphone">仅麦克风（只记入上下文）</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <p className="text-xs text-app-muted-fg">
            当前问题优先，AI
            建议不代表我实际说过。压缩使用当前对话模型在空闲时执行，新问题会抢占摘要请求。
          </p>
        </div>
      </SettingsCard>

      <SettingsCard Icon={Lightbulb} title="出提示">
        <div className="space-y-4">
          <Field
            label="出提示方式"
            note="自动：对方说完一句话就出提示，快捷键可随时干预；手动：只在按「出提示」快捷键时出。对话页面底部和快捷键也能随时切换"
          >
            <Select
              value={conversationHintMode}
              onValueChange={(val) => updateSetting('conversationHintMode', val as HintMode)}
            >
              <SelectTrigger className="w-60 shrink-0 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动（默认）</SelectItem>
                <SelectItem value="manual">手动</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="显示对话原文"
            note="关闭后提示占满整个窗口，每条提示上方仍会显示它对应的问题"
          >
            <Switch
              className="scale-y-90"
              checked={!conversationTranscriptHidden}
              onCheckedChange={(checked) => updateSetting('conversationTranscriptHidden', !checked)}
            />
          </Field>

          <Advanced>
            <Field
              label="说完判定"
              note="对方停顿多久算说完一句话；越短出提示越快。重新开始监听后生效"
            >
              <Select
                value={String(conversationSilenceMs)}
                onValueChange={(val) => updateSetting('conversationSilenceMs', Number(val))}
              >
                <SelectTrigger className="w-60 shrink-0 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SILENCE_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={String(value)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="最短触发字数"
              note="对方说完的一句话少于这个字数（不算标点）时不自动出提示，用来跳过「好的」「嗯」"
            >
              <Select
                value={String(conversationMinChars)}
                onValueChange={(val) => updateSetting('conversationMinChars', Number(val))}
              >
                <SelectTrigger className="w-60 shrink-0 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MIN_CHARS_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} 个字{n === 4 ? '（默认）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </Advanced>
        </div>
      </SettingsCard>

      <SettingsCard Icon={FileText} title="对话记录保存到本地">
        <div className="space-y-4">
          <Field
            label="保存对话记录到本地"
            note="开启后，对方说的话和 AI 提示会自动保存为 Markdown 文件，一段对话一个文件，清空对话后另起一个"
          >
            <Switch
              className="scale-y-90"
              checked={conversationAutoSave}
              onCheckedChange={(checked) => updateSetting('conversationAutoSave', checked)}
            />
          </Field>
          {conversationAutoSave && (
            <SaveDirField
              dir={conversationSaveDir}
              placeholder="默认: 文档/Shiping"
              pick={window.api.selectConversationDir}
              onChange={(dir) => updateSetting('conversationSaveDir', dir)}
            />
          )}
        </div>
      </SettingsCard>
    </>
  )
}
