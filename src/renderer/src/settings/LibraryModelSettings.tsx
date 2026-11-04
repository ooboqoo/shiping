import { Link } from 'react-router'
import { OLLAMA_URL } from '../../../shared/rag'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Database, ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Field, SettingsCard } from './components'
import type {
  LibraryModelDraft,
  LibraryModelKind,
  LibraryModelSettings,
  LibraryProviderModel
} from '../../../shared/library-models'

// Unsaved credentials stay in this app session only, never browser persistence.
const drafts = new Map<LibraryModelKind, { draft: LibraryModelDraft; clearKey: boolean }>()
const options = {
  embedding: [
    ['siliconflow', '硅基流动（国内云端 API）'],
    ['aliyun', '阿里云百炼（国内云端 API）'],
    ['openai-compatible', '自定义云端 Embedding（OpenAI 兼容）'],
    ['ollama', '高级：Ollama（外部服务）'],
    ['xinference', '高级：Xinference（外部服务）']
  ],
  rerank: [
    ['siliconflow', '硅基流动（国内云端 API）'],
    ['aliyun', '阿里云百炼（国内云端 API）'],
    ['rerank-compatible', '自定义云端 Rerank（通用格式）'],
    ['xinference', '高级：Xinference（外部服务）']
  ]
}
const control = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm'
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : '操作失败，请重试').replace(
    /^Error invoking remote method '[^']+': Error: /,
    ''
  )
function initial(kind: LibraryModelKind): LibraryModelDraft {
  return {
    provider: kind === 'embedding' ? 'ollama' : 'local',
    baseURL: '',
    model: '',
    timeoutMs: 30000
  }
}

/** Both desktop sections edit the service's configuration, with no second local copy. */
export function LibraryModelSettingsCard({ kind }: { kind: LibraryModelKind }) {
  const [settings, setSettings] = useState<LibraryModelSettings | null>(null)
  const [draft, setDraft] = useState<LibraryModelDraft>(
    () => drafts.get(kind)?.draft || initial(kind)
  )
  const [models, setModels] = useState<LibraryProviderModel[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(drafts.has(kind) ? '已修改，尚未保存' : '')
  const [error, setError] = useState('')
  const [clearKey, setClearKey] = useState(drafts.get(kind)?.clearKey || false)
  const dirty = useRef(drafts.has(kind))
  const working = useRef(false)
  const generation = useRef(0)
  const embedding = kind === 'embedding'
  const cloud = !['local', 'ollama', 'xinference'].includes(draft.provider)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const read = useCallback(
    async (refreshOnly = false) => {
      if ((dirty.current && !refreshOnly) || working.current) return
      const ticket = ++generation.current
      try {
        const result = await window.api.getLibraryModelSettings()
        if (ticket !== generation.current || (dirty.current && !refreshOnly) || working.current)
          return
        setSettings(result)
        if (!dirty.current) setDraft({ ...initial(kind), ...result[kind], apiKey: undefined })
        setError('')
      } catch (e) {
        if (ticket === generation.current) setError(errorText(e))
      }
    },
    [kind]
  )
  useEffect(() => {
    void read(true)
    const focus = () => {
      void read(true)
    }
    window.addEventListener('focus', focus)
    const timer = setInterval(focus, 5000)
    return () => {
      invalidate()
      window.removeEventListener('focus', focus)
      clearInterval(timer)
    }
  }, [read, invalidate])
  function change(patch: Partial<LibraryModelDraft>, resetKey = false) {
    dirty.current = true
    setDraft((value) => {
      const next = { ...value, ...patch }
      drafts.set(kind, { draft: next, clearKey: resetKey ? false : clearKey })
      return next
    })
    setMessage('已修改，尚未保存')
    setError('')
  }
  function providerChanged(provider: LibraryModelDraft['provider']) {
    const presets: Record<string, [string, string]> = {
      siliconflow: [
        'https://api.siliconflow.cn/v1',
        ''
      ],
      aliyun: ['', ''],
      ollama: [OLLAMA_URL, ''],
      xinference: ['http://127.0.0.1:9997', '']
    }
    const [baseURL, model] = presets[provider] || ['', '']
    change({ provider, baseURL, model, apiKey: '' }, true)
    setModels([])
    setClearKey(false)
  }
  function payload(): LibraryModelDraft {
    const config = { ...draft }
    if (clearKey) config.apiKey = ''
    else if (!config.apiKey) delete config.apiKey
    return config
  }
  async function run(action: 'save' | 'models' | 'test') {
    if (working.current || !settings || draft.provider === 'local') return
    working.current = true
    generation.current++
    setBusy(true)
    setError('')
    setMessage('正在处理…')
    try {
      if (action === 'save') {
        const result = await window.api.saveLibraryModel(kind, payload())
        setSettings(result)
        setDraft({ ...initial(kind), ...result[kind], apiKey: undefined })
        setClearKey(false)
        dirty.current = false
        drafts.delete(kind)
        setMessage(
          embedding
            ? '已保存。更换向量模型后请重建各知识库索引。'
            : '精排模型已保存，可在资料库中启用。'
        )
      } else if (action === 'models') {
        const result = await window.api.listLibraryModels(kind, payload())
        setModels(
          result.filter(
            (item) =>
              !item.type || item.type === kind || (kind === 'rerank' && item.type === 'reranker')
          )
        )
        setMessage(
          result.some((item) => item.source === 'preset')
            ? '已加载推荐模型，实际权限请通过测试连接确认。'
            : '已获取模型列表，也可手动填写名称。'
        )
      } else {
        const result = await window.api.testLibraryModel(kind, payload())
        setMessage(
          result.dimensions ? `连接测试成功，向量维度 ${result.dimensions}` : '精排调用测试成功'
        )
      }
    } catch (e) {
      setError(errorText(e))
      setMessage('')
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  const hasKey =
    settings?.[kind].hasApiKey &&
    settings[kind].provider === draft.provider &&
    settings[kind].baseURL === draft.baseURL
  return (
    <SettingsCard
      Icon={embedding ? Database : ListFilter}
      title={embedding ? 'Embedding 向量模型' : 'Rerank 精排'}
    >
      <div className="space-y-4" aria-label={embedding ? '向量模型配置' : '精排模型配置'}>
        <p className="text-xs font-light">与本机知识库网页共用配置，适用于所有知识库。</p>
        {embedding && settings?.embedding.configured === false && (
          <p role="status" className="text-xs text-amber-800">
            首次使用请在此填写 API Key 并保存模型配置；上传的资料会等待模型配置后建立索引。
          </p>
        )}
        <fieldset disabled={busy || !settings} className="space-y-4">
          <div className="text-sm">
            <p className="mb-2">模型提供商</p>
            <div role="group" aria-label={`${kind} 提供商`} className="flex flex-wrap gap-2">
              {options[kind].map(([id, name]) => (
                <Button key={id} type="button" variant="outline"
                  aria-pressed={draft.provider === id}
                  className={draft.provider === id ? 'border-blue-500 bg-blue-50 text-blue-800' : 'bg-white'}
                  onClick={() => providerChanged(id as LibraryModelDraft['provider'])}>
                  {name}
                </Button>
              ))}
            </div>
          </div>
          {draft.provider === 'local' && (
            <p role="status" className="text-xs text-amber-800">
              旧本机配置已停用，请选择提供商并保存模型。
            </p>
          )}
          {draft.provider !== 'local' && (
            <>
              <label className="block text-sm">
                Base URL
                <Input
                  aria-label={`${kind} Base URL`}
                  className="bg-white"
                  value={draft.baseURL || ''}
                  placeholder={
                    draft.provider === 'aliyun'
                      ? 'https://业务空间ID.cn-beijing.maas.aliyuncs.com'
                      : '服务 API 根地址'
                  }
                  onChange={(e) => change({ baseURL: e.target.value })}
                />
              </label>
              {draft.provider === 'aliyun' && (
                <p className="text-xs font-light">
                  填写百炼国内业务空间服务域名，需与 API Key 地域一致。下方模型列表为推荐项。
                </p>
              )}
              <label className="block text-sm">
                模型名称 / UID
                <Input
                  aria-label={`${kind} 模型名称`}
                  className="bg-white"
                  value={draft.model || ''}
                  onChange={(e) => change({ model: e.target.value })}
                />
              </label>
              {models.length > 0 && (
                <select
                  aria-label={`${kind} 模型列表`}
                  className={control}
                  value=""
                  onChange={(e) => change({ model: e.target.value })}
                >
                  <option value="">从列表选择模型</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                </select>
              )}
              <label className="block text-sm">
                API Key{cloud ? '（必填）' : '（可选）'}
                <Input
                  aria-label={`${kind} API Key`}
                  type="password"
                  autoComplete="new-password"
                  className="bg-white"
                  value={draft.apiKey || ''}
                  placeholder={hasKey ? '已保存密钥；留空保留' : '输入平台 API Key'}
                  onChange={(e) => change({ apiKey: e.target.value })}
                />
              </label>
              {!cloud && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(e) => {
                      setClearKey(e.target.checked)
                      dirty.current = true
                      drafts.set(kind, { draft, clearKey: e.target.checked })
                    }}
                  />
                  清除已保存密钥
                </label>
              )}
              <label className="block text-sm">
                请求超时（毫秒）
                <Input
                  aria-label={`${kind} 超时`}
                  type="number"
                  min={100}
                  max={60000}
                  className="bg-white"
                  value={draft.timeoutMs ?? 30000}
                  onChange={(e) => change({ timeoutMs: Number(e.target.value) })}
                />
              </label>
            </>
          )}
          {cloud && (
            <div className="rounded-md bg-white/60 p-3 text-xs space-y-2">
              <p>
                云端模型需在平台开通额度。测试、建立索引和检索按平台规则计费，相关文本会发送至所选平台。
              </p>
              {['siliconflow', 'aliyun'].includes(draft.provider) && (
                <a
                  className="underline"
                  target="_blank"
                  rel="noreferrer"
                  href={
                    draft.provider === 'aliyun'
                      ? 'https://bailian.console.aliyun.com/'
                      : 'https://cloud.siliconflow.cn/'
                  }
                >
                  开通服务 / 获取 API Key
                </a>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {draft.provider !== 'local' && (
              <Button variant="outline" onClick={() => void run('models')}>
                获取模型列表
              </Button>
            )}
            <Button
              disabled={draft.provider === 'local'}
              variant="outline"
              onClick={() => void run('test')}
            >
              测试连接
            </Button>
            <Button disabled={draft.provider === 'local'} onClick={() => void run('save')}>
              保存配置
            </Button>
            {dirty.current && (
              <Button
                variant="ghost"
                onClick={() => {
                  dirty.current = false
                  drafts.delete(kind)
                  setClearKey(false)
                  setDraft({ ...initial(kind), ...settings?.[kind], apiKey: undefined })
                  setMessage('已放弃未保存的修改')
                  void read()
                }}
              >
                放弃修改
              </Button>
            )}
          </div>
        </fieldset>
        {message && (
          <p className="text-xs" role="status">
            {message}
          </p>
        )}
        {error && (
          <div role="alert" className="text-xs text-red-700">
            {error}{' '}
            <Button variant="link" size="sm" onClick={() => void read(true)}>
              重新连接
            </Button>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}

/** Retrieval only owns the enable switch; provider credentials live under AI models. */
export function LibraryRerankSwitch() {
  const [settings, setSettings] = useState<LibraryModelSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    let alive = true
    async function read() {
      if (working.current) return
      const ticket = ++revision.current
      try {
        const result = await window.api.getLibraryModelSettings()
        if (alive && ticket === revision.current && !working.current) {
          setSettings(result)
          setError('')
        }
      } catch (e) {
        if (alive && ticket === revision.current) setError(errorText(e))
      }
    }
    void read()
    const focus = () => void read()
    window.addEventListener('focus', focus)
    const timer = setInterval(focus, 5000)
    return () => {
      alive = false
      revision.current++
      clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [])
  const legacy = settings?.rerank.provider === 'local'
  async function toggle(enabled: boolean) {
    if (working.current || !settings || (enabled && legacy)) return
    working.current = true
    revision.current++
    setBusy(true)
    setError('')
    try {
      const result = await window.api.setLibraryRerank(enabled)
      setSettings(
        (current) =>
          current && {
            ...current,
            rerank: { ...current.rerank, enabled: result.reranker }
          }
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  return (
    <SettingsCard Icon={ListFilter} title="知识库检索">
      <Field label="启用 Rerank 精排" note="仅在知识库检索时生效；失败会保留原检索排序">
        <Switch
          aria-label="启用 Rerank 精排"
          checked={!legacy && settings?.rerank.enabled === true}
          disabled={busy || !settings || legacy || settings.rerank.configured === false}
          onCheckedChange={(enabled) => void toggle(enabled)}
        />
      </Field>
      <p className="mt-3 text-xs">
        {legacy
          ? '旧本机配置已停用，请先选择精排模型。'
          : settings
            ? settings.rerank.configured === false
              ? '尚未配置精排模型'
              : `当前模型：${settings.rerank.model || '尚未配置'}`
            : '正在读取模型配置…'}{' '}
        <Link className="underline" to="/settings?tab=ai">
          前往 AI 模型配置
        </Link>
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </SettingsCard>
  )
}
