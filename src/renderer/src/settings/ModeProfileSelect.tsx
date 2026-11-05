import { TriangleAlert } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSettingsStore, type AppMode, type ApiProfile } from '@/lib/store/settings'
import { thinkingTag } from '@/lib/api-profiles'
import { Field } from './components'

const NOTES: Record<AppMode, string> = {
  screenshot: '截图要发给模型识别，需要能识图的模型；不支持识图的配置不能选',
  conversation: '只发文字，识图模型也能用；换成关闭思考的快模型，出提示更快'
}

function describe(profile: ApiProfile, mode: AppMode): string {
  const tags = [
    profile.model || '未设置模型',
    thinkingTag(profile),
    profile.vision === true && mode === 'screenshot' && '识图',
    profile.vision === false && '仅文本'
  ].filter(Boolean)
  return `${profile.name.trim() || '未命名配置'}（${tags.join(' · ')}）`
}

/**
 * Which saved profile a mode sends its requests with. 截图模式 cannot pick a
 * profile known to take no images; an unknown one is allowed, since most
 * platforms never say.
 */
export function ModeProfileSelect({
  mode,
  onEdit
}: {
  mode: AppMode
  /** Open the profile in the AI 模型 group */
  onEdit: (profileId: string) => void
}) {
  const { apiProfiles, setModeProfile } = useSettingsStore()
  const selectedId = useSettingsStore((s) =>
    mode === 'screenshot' ? s.screenshotProfileId : s.conversationProfileId
  )
  const selected = apiProfiles.find((p) => p.id === selectedId)

  return (
    <div>
      <Field
        label="使用的 AI 配置"
        note={
          <>
            {NOTES[mode]}
            {selected && (
              <button
                className="ml-1 text-blue-700 hover:underline cursor-pointer"
                onClick={() => onEdit(selected.id)}
              >
                编辑
              </button>
            )}
          </>
        }
      >
        <Select value={selectedId} onValueChange={(id) => setModeProfile(mode, id)}>
          <SelectTrigger className="w-60 shrink-0 bg-white">
            <SelectValue placeholder="选择配置" />
          </SelectTrigger>
          <SelectContent>
            {apiProfiles.map((profile) => (
              <SelectItem
                key={profile.id}
                value={profile.id}
                disabled={mode === 'screenshot' && profile.vision === false}
              >
                {describe(profile, mode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {mode === 'screenshot' && selected?.vision === false && (
        <p className="mt-1.5 flex items-start justify-end gap-1 text-right text-xs text-amber-800">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>这个配置的模型不支持图片输入，截图会失败，请换一个能识图的配置</span>
        </p>
      )}
      {selected && !selected.apiKey.trim() && (
        <p className="mt-1.5 flex items-start justify-end gap-1 text-right text-xs text-amber-800">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>这个配置还没有填写 API Key</span>
        </p>
      )}
    </div>
  )
}
