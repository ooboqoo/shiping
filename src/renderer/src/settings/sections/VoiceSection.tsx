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
import { Advanced, Field, SecretInput, SettingsCard } from '../components'

/** Speech recognition, shared by both modes: 截图模式 attaches it, 对话模式 is built on it */
export function VoiceSection() {
  const { dashscopeApiKey, audioInputDeviceId, audioOutputDeviceId, updateSetting } =
    useSettingsStore()
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
