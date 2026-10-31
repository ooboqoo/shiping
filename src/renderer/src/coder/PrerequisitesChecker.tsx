import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Eye, EyeOff } from 'lucide-react'
import { useSettingsStore } from '@/lib/store/settings'
import { Button } from '@/components/ui/button'
import { SelectBaseURL } from '@/settings/SelectBaseURL'
import { changeApiBaseURL } from '@/lib/model-switch'
import { PROVIDERS } from '@/lib/providers'

/** Preselected for a first setup: the recommended platform, so a key alone is enough */
const RECOMMENDED_BASE_URL = PROVIDERS.find((p) => p.id === 'deepseek')!.baseURL

/** Whether any saved profile already holds a key, even if the flag is not set yet */
function hasAnyKeyStored(): boolean {
  const store = useSettingsStore.getState()
  return store.apiKey.trim() !== '' || store.apiProfiles.some((p) => p.apiKey.trim() !== '')
}

export function PrerequisitesChecker() {
  const navigate = useNavigate()
  const { apiKey, apiBaseURL, hasConfiguredApi, updateCredential } = useSettingsStore()
  const [inputApiKey, setInputApiKey] = useState(apiKey)
  // null until the user picks: follows the store meanwhile, so a URL from `.env`
  // synced after mount still wins over the recommended one
  const [pickedBaseURL, setInputApiBaseURL] = useState<string | null>(null)
  const inputApiBaseURL = pickedBaseURL ?? (apiBaseURL || RECOMMENDED_BASE_URL)
  const [showApiKey, setShowApiKey] = useState(false)

  // The dialog only asks for a key once in the app's life. It used to key off
  // the live `apiKey`, which reappeared whenever the user switched to a profile
  // that was still blank — while they were mid-task, over the whole window.
  const shouldShow = !hasConfiguredApi && !hasAnyKeyStored()

  // Adopt a key that was configured in the settings page while this was hidden
  useEffect(() => {
    if (hasConfiguredApi) return
    if (hasAnyKeyStored()) useSettingsStore.getState().markApiConfigured()
  }, [hasConfiguredApi])

  const saveApiKey = () => {
    if (inputApiKey.trim()) {
      // Through the active profile, or the key is lost on the next profile switch
      updateCredential({ apiKey: inputApiKey.trim() })
    }
    if (inputApiBaseURL.trim()) {
      // Also picks a model in this platform's spelling, so first use works out of the box
      changeApiBaseURL(inputApiBaseURL.trim())
    }
  }

  if (!shouldShow) return null

  return (
    <div className="fixed top-9 left-0 right-0 bottom-0 flex bg-black/50">
      <div className="m-auto bg-white rounded-lg p-6 pt-1 w-120 shadow-lg">
        <h1 className="text-xl font-bold text-center mb-2">欢迎使用识屏</h1>
        <div className="text-sm text-gray-600">
          请先配置 AI 平台，推荐使用
          <a
            href="https://platform.deepseek.com/"
            target="_blank"
            rel="noreferrer"
            className="text-blue-500 mx-1"
          >
            DeepSeek
          </a>
          ，已经选好它的地址，填上 API Key 即可。其他兼容 OpenAI API
          的平台也可以，在下面换成它的地址。
        </div>

        <div className="space-y-2 my-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              API Base URL{' '}
              <span className="text-xs font-normal text-gray-500">(留空即 OpenAI 官方)</span>
            </label>
            <SelectBaseURL
              className="w-full"
              value={inputApiBaseURL}
              onChange={setInputApiBaseURL}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">API Key</label>
            <div className="flex">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={inputApiKey}
                onChange={(e) => setInputApiKey(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-l-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="请输入 API Key"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowApiKey(!showApiKey)}
                className="border border-l-0 rounded-l-none rounded-r-md h-9 w-9 hover:border-none"
              >
                {showApiKey ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <Button disabled={!inputApiKey.trim()} className="flex-1" onClick={saveApiKey}>
            开始使用
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              saveApiKey()
              navigate('/settings')
            }}
            className="flex-1"
          >
            更多设置
          </Button>
        </div>
      </div>
    </div>
  )
}
