import { useEffect, useState } from 'react'
import { FileText, Lightbulb, MessagesSquare, TriangleAlert, Mic } from 'lucide-react'
import type { ConversationAudioMode } from '../../../../shared/conversation'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
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
    conversationHintMode,
    conversationSummaryEnabled,
    conversationSummaryRounds,
    conversationSummaryBudget,
    conversationAudioMode,
    conversationMicrophoneDeviceId,
    conversationSilenceMs,
    conversationMinChars,
    conversationTranscriptHidden,
    conversationAutoSave,
    conversationSaveDir,
    updateSetting
  } = useSettingsStore()
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    if (conversationAudioMode === 'system') return
    // Enumerating does not request microphone permission; starting own speech does.
    void navigator.mediaDevices.enumerateDevices().then(
      (devices) => setMicrophones(devices.filter((d) => d.kind === 'audioinput')),
      () => setMicrophones([])
    )
  }, [conversationAudioMode])

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

      <SettingsCard Icon={Mic} title="对话音源">
        <div className="space-y-4">
          <Field
            label="录音来源"
            note="默认只听「设置 → 语音」所选的对方音源。双路录音额外识别自己的回答，会增加语音识别费用；自己的回答不会触发或打断提示。重新开始监听后生效"
          >
            <Select
              value={conversationAudioMode}
              onValueChange={(val) =>
                updateSetting('conversationAudioMode', val as ConversationAudioMode)
              }
            >
              <SelectTrigger className="w-60 shrink-0 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">仅对方音源（默认）</SelectItem>
                <SelectItem value="dual">对方音源 + 自己的麦克风</SelectItem>
                <SelectItem value="microphone">仅自己的麦克风（记录回答）</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {conversationAudioMode !== 'system' && (
            <Field
              label="自己的麦克风"
              note="与对方音源分别选择。建议佩戴耳机，扬声器回声可能被当成自己的回答；仅记录自己时不会自动出提示。"
            >
              <Select
                value={conversationMicrophoneDeviceId || 'default'}
                onValueChange={(val) =>
                  updateSetting('conversationMicrophoneDeviceId', val === 'default' ? '' : val)
                }
              >
                <SelectTrigger className="w-60 shrink-0 bg-white">
                  <SelectValue placeholder="系统默认麦克风" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">系统默认麦克风</SelectItem>
                  {microphones
                    .filter((d) => d.deviceId && d.deviceId !== 'default')
                    .map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label || d.deviceId}
                      </SelectItem>
                    ))}
                  {conversationMicrophoneDeviceId &&
                    !microphones.some((d) => d.deviceId === conversationMicrophoneDeviceId) && (
                      <SelectItem value={conversationMicrophoneDeviceId}>
                        {conversationMicrophoneDeviceId}（已保存）
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
            </Field>
          )}
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
              note="对方停顿多久算说完一句话；越短出提示越快。听起来是问句时会提前约 0.35 秒开始出提示，对方接着说就自动重写。重新开始监听后生效"
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
              note="对方说完的一句话少于这个字数（不算标点）时不自动出提示，用来跳过「好的」「嗯」；「为什么？」这类问句 2 个字就够"
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

      <SettingsCard Icon={MessagesSquare} title="补充问答摘要">
        <div className="space-y-4">
          <Field
            label="附带最近问答的摘要"
            note="默认关闭。开启后，空闲时使用对话模式的 AI 配置额外生成摘要，会产生后台调用费用。新问题直接出提示，不等待摘要；关闭后仍保留原有对话原文、最近提示和滚动备忘。"
          >
            <Switch
              className="scale-y-90"
              checked={conversationSummaryEnabled}
              onCheckedChange={(checked) => updateSetting('conversationSummaryEnabled', checked)}
            />
          </Field>
          {conversationSummaryEnabled && (
            <>
              <Field
                label="最近问答轮数"
                note="1–20 轮，默认 3 轮；只附带已生成的摘要。重写同一条提示仍算同一轮。"
              >
                <Select
                  value={String(conversationSummaryRounds)}
                  onValueChange={(value) =>
                    updateSetting('conversationSummaryRounds', Number(value))
                  }
                >
                  <SelectTrigger className="w-32 shrink-0 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} 轮
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="补充摘要预算"
                note="100–4000 个估算 token，默认 1000；只限制新增摘要，不会缩短当前问题、原文或重写时的上一版提示。与滚动备忘和最近提示可能有内容重复。"
              >
                <Input
                  className="w-32 shrink-0 bg-white"
                  type="number"
                  min={100}
                  max={4000}
                  step={100}
                  key={conversationSummaryBudget}
                  defaultValue={conversationSummaryBudget}
                  onBlur={(event) => {
                    const budget = Math.min(
                      4000,
                      Math.max(100, Math.round(Number(event.target.value) || 100))
                    )
                    event.target.value = String(budget)
                    updateSetting('conversationSummaryBudget', budget)
                  }}
                  aria-label="补充摘要预算（估算 token）"
                />
              </Field>
            </>
          )}
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
