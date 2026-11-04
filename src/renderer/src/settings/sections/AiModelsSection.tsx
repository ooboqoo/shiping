import { LibraryModelSettingsCard } from '../LibraryModelSettings'
import { Bot } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/lib/store/settings'
import { changeApiBaseURL } from '@/lib/model-switch'
import { ApiProfiles, ApiSaveStatus } from '../ApiProfiles'
import { ApiHeadersField } from '../ApiHeadersField'
import { ModelField } from '../ModelField'
import { SelectBaseURL } from '../SelectBaseURL'
import { Advanced, Field, SecretInput, SettingsCard } from '../components'

/** Every saved AI profile; the modes pick theirs in their own groups or via 「用于」 */
export function AiModelsSection() {
  const { apiBaseURL, apiKey, apiHeaders, disableThinking, updateCredential } = useSettingsStore()

  return (
    <div className="space-y-4">
      <SettingsCard Icon={Bot} title="AI 模型" extra={<ApiSaveStatus />}>
        <p className="-mt-2 mb-4 text-xs font-light">
          在这里保存常用的 AI 配置；截图模式和对话模式各自选用其中一个，互不影响
        </p>
        <ApiProfiles>
          <Field label="API Base URL" note="可选常用平台，也可输入其他 OpenAI 兼容地址">
            <SelectBaseURL value={apiBaseURL} onChange={changeApiBaseURL} />
          </Field>

          <Field label="API Key">
            <SecretInput
              value={apiKey}
              onChange={(value) => updateCredential({ apiKey: value })}
              placeholder="输入 API Key"
            />
          </Field>

          <ModelField />

          <Field
            label="关闭思考"
            note="跳过答题前看不见的思考过程，出字更快，难题可能不如开着准；模型不支持时自动忽略"
          >
            <Switch
              className="scale-y-90"
              checked={disableThinking}
              onCheckedChange={(checked) => updateCredential({ disableThinking: checked })}
            />
          </Field>

          <Advanced defaultOpen={!!apiHeaders.trim()}>
            <ApiHeadersField />
          </Advanced>
        </ApiProfiles>
      </SettingsCard>
      <LibraryModelSettingsCard kind="embedding" />
      <LibraryModelSettingsCard kind="rerank" />
    </div>
  )
}
