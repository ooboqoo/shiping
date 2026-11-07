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
        const needsPermission = devices.every((d) => !d.label)
        if (needsPermission) {
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          probe.getTracks().forEach((track) => track.stop())
        }
        const refreshed = await navigator.mediaDevices.enumerateDevices()
        setAudioDevices(refreshed)
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
          label="音频输入设备"
          note="截图模式：默认捕获系统音频。双路对话模式：此处选定的设备用作我的麦克风，未选则使用默认麦克风；电脑声音单独采集"
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
                .filter((d) => d.kind === 'audioinput')
                .map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>

        <Advanced defaultOpen={!!audioOutputDeviceId}>
          <Field label="音频输出设备" note="用于录音处理的输出设备，麦克风不会回放到扬声器">
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
                  .filter((d) => d.kind === 'audiooutput')
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
