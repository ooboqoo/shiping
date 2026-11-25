import { useEffect, useState } from 'react'
import { Mic } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSettingsStore } from '@/lib/store/settings'
import { normalizeTranscriptionProvider } from '../../../../shared/transcription'
import { Advanced, Field, SecretInput, SettingsCard } from '../components'

/** Speech recognition, shared by both modes: 截图模式 attaches it, 对话模式 is built on it */
export function VoiceSection() {
  const {
    transcriptionProvider,
    dashscopeApiKey,
    openaiTranscriptionApiKey,
    audioInputDeviceId,
    audioOutputDeviceId,
    updateSetting
  } = useSettingsStore()
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setAudioDevices(devices)
      } catch (err) {
        console.error('Failed to enumerate audio devices:', err)
      }
    }
    loadDevices()
  }, [])

  return (
    <SettingsCard Icon={Mic} title="语音">
      <div className="space-y-4">
        <Field
          label="语音识别服务"
          note="截图模式和对话模式共用。切换后重新开始监听生效；音频会发送给所选服务，请确认对话参与者同意并遵守相关规定。"
        >
          <Select
            value={transcriptionProvider}
            onValueChange={(value) =>
              updateSetting('transcriptionProvider', normalizeTranscriptionProvider(value))
            }
          >
            <SelectTrigger className="w-60 shrink-0 bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dashscope">百炼 Fun-ASR（默认）</SelectItem>
              <SelectItem value="openai-realtime">OpenAI Realtime（低延迟）</SelectItem>
              <SelectItem value="openai-whisper">OpenAI Whisper（分段）</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {transcriptionProvider === 'dashscope' ? (
          <Field
            label="百炼平台 API Key"
            note={
              <>
                从阿里云
                <a
                  href="https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-0.5 text-blue-700 hover:underline"
                >
                  百炼平台
                </a>
                获取；对话模式必填，截图模式不用语音转录可跳过
              </>
            }
          >
            <SecretInput
              value={dashscopeApiKey}
              onChange={(value) => updateSetting('dashscopeApiKey', value)}
              placeholder="输入百炼平台 API Key"
            />
          </Field>
        ) : (
          <Field
            label="OpenAI API Key"
            note={
              <>
                在{' '}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-700 hover:underline"
                >
                  OpenAI 平台
                </a>{' '}
                创建，与 AI 模型配置独立。
                {transcriptionProvider === 'openai-realtime'
                  ? '使用 gpt-live-transcribe 实时流式识别；需可访问 OpenAI Realtime WebSocket。'
                  : '使用 whisper-1，语音停顿后上传 WAV 并等待结果，不提供实时逐字转录。该模型已弃用，预计 2027 年 2 月 26 日停止服务。'}{' '}
                两种服务均按 OpenAI API 计费。
              </>
            }
          >
            <SecretInput
              value={openaiTranscriptionApiKey}
              onChange={(value) => updateSetting('openaiTranscriptionApiKey', value)}
              placeholder="输入 OpenAI API Key"
            />
          </Field>
        )}

        <Field
          label="对方音源"
          note="默认捕获系统音频，即会议里对方的声音；也可以选虚拟声卡等输入设备。截图模式的语音转录也用它。自己的麦克风在「设置 → 对话模式」单独选"
        >
          <Select
            value={audioInputDeviceId || 'system'}
            onValueChange={(val) =>
              updateSetting('audioInputDeviceId', val === 'system' ? '' : val)
            }
          >
            <SelectTrigger className="w-60 shrink-0 bg-white">
              <SelectValue placeholder="系统音频（默认）" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">系统音频（默认）</SelectItem>
              {audioDevices
                .filter((d) => d.kind === 'audioinput' && d.deviceId)
                .map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </SelectItem>
                ))}
              {audioInputDeviceId &&
                !audioDevices.some((d) => d.deviceId === audioInputDeviceId) && (
                  <SelectItem value={audioInputDeviceId}>{audioInputDeviceId}（已保存）</SelectItem>
                )}
            </SelectContent>
          </Select>
        </Field>

        <Advanced defaultOpen={!!audioOutputDeviceId}>
          <Field label="音频输出设备" note="识别时不播放声音，这一项不影响识别">
            <Select
              value={audioOutputDeviceId || 'default'}
              onValueChange={(val) =>
                updateSetting('audioOutputDeviceId', val === 'default' ? '' : val)
              }
            >
              <SelectTrigger className="w-60 shrink-0 bg-white">
                <SelectValue placeholder="默认设备" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">默认设备</SelectItem>
                {audioDevices
                  .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
                  .map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label || d.deviceId}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
        </Advanced>
      </div>
    </SettingsCard>
  )
}
