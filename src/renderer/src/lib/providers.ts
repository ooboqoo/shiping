/**
 * Known AI platforms and how each one spells the same model.
 *
 * Every platform names models its own way: DeepSeek's own API takes
 * `deepseek-flash`, OpenRouter wants `deepseek/deepseek-v4.1-flash`, SiliconFlow
 * writes `Qwen/Qwen3-VL-32B-Instruct` where OpenRouter writes
 * `qwen/qwen3-vl-32b-instruct`. This table lets the settings page offer the
 * right spelling for the selected API Base URL and translate the model when the
 * user switches platforms.
 */

export type ProviderId = 'deepseek' | 'openrouter' | 'siliconflow' | 'openai'

export interface Provider {
  id: ProviderId
  name: string
  baseURL: string
  /** Hostnames served by this platform; subdomains match too */
  hosts: string[]
  /** `prefixed` model IDs carry a vendor (`qwen/...`), `bare` ones don't (`gpt-6-sol`) */
  naming: 'prefixed' | 'bare'
  /** Picked when switching to this platform and nothing better is known */
  defaultModel: string
  /** The `/models` endpoint answers without an API key */
  publicModelList?: boolean
  /** Query string for `/models`, to leave out models that can't chat (embeddings, image generation…) */
  modelListQuery?: string
  /** Where main looks up which models take images, when `/models` doesn't say */
  visionCatalog?: 'siliconflow'
}

export const PROVIDERS: Provider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    hosts: ['api.deepseek.com'],
    naming: 'bare',
    defaultModel: 'deepseek-flash'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    hosts: ['openrouter.ai'],
    naming: 'prefixed',
    defaultModel: 'openai/gpt-6-luna',
    publicModelList: true
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    hosts: ['siliconflow.cn', 'siliconflow.com'],
    naming: 'prefixed',
    defaultModel: 'Qwen/Qwen3-VL-32B-Instruct',
    modelListQuery: 'sub_type=chat',
    visionCatalog: 'siliconflow'
  },
  {
    // An empty API Base URL means the OpenAI SDK default, i.e. OpenAI itself
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    hosts: ['api.openai.com'],
    naming: 'bare',
    defaultModel: 'gpt-6-luna'
  }
]

/**
 * One row per model: its ID on each platform that serves it. The first ID of a
 * platform is the one offered and switched to; later ones are aliases that are
 * only recognised. Every entry must accept image input — the app sends screenshots.
 */
const MODEL_FAMILIES: Partial<Record<ProviderId, string[]>>[] = [
  {
    deepseek: ['deepseek-flash'],
    openrouter: ['deepseek/deepseek-v4.1-flash', '~deepseek/deepseek-flash-latest']
  },
  { siliconflow: ['Qwen/Qwen3-VL-32B-Instruct'], openrouter: ['qwen/qwen3-vl-32b-instruct'] },
  { siliconflow: ['Qwen/Qwen3-VL-8B-Thinking'], openrouter: ['qwen/qwen3-vl-8b-thinking'] },
  { siliconflow: ['zai-org/GLM-4.5V'], openrouter: ['z-ai/glm-4.5v'] },
  // GPT-6 tiers from fast to flagship: Luna < Sol < Astra
  { openai: ['gpt-6-luna'], openrouter: ['openai/gpt-6-luna'] },
  { openai: ['gpt-6-sol'], openrouter: ['openai/gpt-6-sol'] },
  { openai: ['gpt-6-astra'], openrouter: ['openai/gpt-6-astra'] }
]

/**
 * Former presets: no longer offered, but still recognised, so a model saved
 * back then keeps translating when the user switches platforms.
 */
const RETIRED_MODEL_FAMILIES: Partial<Record<ProviderId, string[]>>[] = [
  { openai: ['gpt-5.6-luna'], openrouter: ['openai/gpt-5.6-luna'] },
  { openai: ['gpt-5.6-terra'], openrouter: ['openai/gpt-5.6-terra'] },
  { openai: ['gpt-5.6-sol'], openrouter: ['openai/gpt-5.6-sol'] }
]

/** Canonical form used as a storage key: trimmed, no trailing slash */
export function normalizeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** The known platform behind an API Base URL; an empty URL is OpenAI */
export function findProvider(baseURL: string): Provider | undefined {
  const url = normalizeBaseURL(baseURL)
  if (!url) return PROVIDERS.find((p) => p.id === 'openai')
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  return PROVIDERS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
}

/** Recommended models for a platform, in its own spelling */
export function getProviderModels(provider: Provider): string[] {
  return MODEL_FAMILIES.flatMap((f) => f[provider.id]?.slice(0, 1) ?? [])
}

/** Loose match, only for recognising a model; platforms themselves compare IDs exactly */
const sameIdLoosely = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function findFamily(model: string) {
  return [...MODEL_FAMILIES, ...RETIRED_MODEL_FAMILIES].find((f) =>
    Object.values(f).some((ids) => ids.some((id) => sameIdLoosely(id, model)))
  )
}

/**
 * Whether `model` takes images, as far as the preset table knows: every preset
 * does, anything else is unknown until the platform's model list says.
 */
export function knownVision(model: string): true | undefined {
  return model && findFamily(model) ? true : undefined
}

/** Whether `model` is exactly one of the platform's known IDs (aliases included) */
export function isProviderModel(provider: Provider, model: string): boolean {
  return !!findFamily(model)?.[provider.id]?.includes(model)
}

/** The same model spelled for `provider`, if it serves it */
export function translateModel(model: string, provider: Provider): string | undefined {
  return findFamily(model)?.[provider.id]?.[0]
}

/** Other platforms whose exact spelling `model` is (empty for models outside the table) */
function spellingOrigins(model: string, provider: Provider): Provider[] {
  const family = findFamily(model)
  if (!family) return []
  return PROVIDERS.filter((p) => p.id !== provider.id && family[p.id]?.includes(model))
}

/**
 * Chinese copy spacing: a space between CJK and Latin text, none between CJK
 * characters, so `${name}推荐` reads 「OpenRouter 推荐」 and 「硅基流动推荐」.
 */
export function cjkSpacing(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9~])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')
}

export type ModelSwitchReason = 'translated' | 'remembered' | 'default'

/**
 * Which model to use after switching the API Base URL, or `null` to keep the
 * current one. Prefers the same model in the new platform's spelling, then the
 * model last used with that URL, then the platform's default.
 */
export function resolveLinkedModel({
  model,
  baseURL,
  remembered,
  customModels
}: {
  model: string
  baseURL: string
  /** Model last used with `baseURL` */
  remembered?: string
  /** Custom models the user created for `baseURL` */
  customModels: string[]
}): { model: string; reason: ModelSwitchReason } | null {
  const provider = findProvider(baseURL)
  if (!provider) {
    // Unknown platform (a proxy, a self-hosted gateway…): its spelling can't be
    // guessed, so only restore what the user picked there before
    return remembered && remembered !== model ? { model: remembered, reason: 'remembered' } : null
  }

  if (
    model &&
    (isProviderModel(provider, model) || customModels.includes(model) || remembered === model)
  ) {
    return null
  }
  const translated = model ? translateModel(model, provider) : undefined
  if (translated) return { model: translated, reason: 'translated' }
  if (remembered) return { model: remembered, reason: 'remembered' }
  return model ? { model: '', reason: 'default' } : null
}

/** A model reported by the platform's `/models` endpoint */
export interface PlatformModel {
  id: string
  /** Accepts image input; unknown unless the platform (OpenRouter) or a vision catalog says */
  vision?: boolean
}

/** Last path segment, lower-cased: `Qwen/Qwen3-VL-32B-Instruct` → `qwen3-vl-32b-instruct` */
const modelStem = (id: string) => id.replace(/^~/, '').split('/').pop()!.toLowerCase()

/**
 * A platform model that is most likely what the user meant by `model`: a
 * case-only difference, then the same name under another vendor prefix, then
 * a longer name of the same model (`deepseek-flash` → `deepseek-flash-latest`).
 */
function guessPlatformModel(model: string, models: PlatformModel[]): PlatformModel | undefined {
  const stem = modelStem(model)
  return (
    models.find((m) => sameIdLoosely(m.id, model)) ??
    models.find((m) => modelStem(m.id) === stem) ??
    models.find((m) => modelStem(m.id).startsWith(`${stem}-`))
  )
}

export interface ModelDiagnosis {
  message: string
  /** One-click replacement */
  fix?: { label: string; model: string }
}

/**
 * Explain why `model` probably won't work with `baseURL`, or `null` when it
 * looks fine. `platformModels` is the platform's own model list when fetched,
 * which beats every guess made from naming conventions.
 */
export function diagnoseModel(
  model: string,
  baseURL: string,
  platformModels?: PlatformModel[],
  /** 截图模式 uses this profile, so a model without image input is a problem */
  requireVision = true
): ModelDiagnosis | null {
  const diagnosis = diagnose(model, baseURL, platformModels, requireVision)
  return diagnosis && { ...diagnosis, message: cjkSpacing(diagnosis.message) }
}

function diagnose(
  model: string,
  baseURL: string,
  platformModels: PlatformModel[] | undefined,
  requireVision: boolean
): ModelDiagnosis | null {
  const provider = findProvider(baseURL)
  const platformName = provider?.name ?? '当前平台'

  if (!model) {
    return provider
      ? {
          message: '还没有选择模型',
          fix: { label: `使用 ${provider.defaultModel}`, model: provider.defaultModel }
        }
      : { message: '还没有选择模型，请选择或输入该平台支持的模型名称' }
  }

  const listed = platformModels?.find((m) => m.id === model)
  if (listed) {
    return listed.vision === false && requireVision
      ? { message: '截图模式正在使用这个配置，但该模型不支持图片输入，无法识别截图' }
      : null
  }

  if (provider && !isProviderModel(provider, model)) {
    const origins = spellingOrigins(model, provider)
    if (origins.length > 0) {
      const originNames = origins.map((p) => p.name).join(' / ')
      const translated = translateModel(model, provider)
      return translated
        ? {
            message: `这是${originNames}的写法，${platformName}上应为${translated}`,
            fix: { label: '替换', model: translated }
          }
        : {
            message: `这是${originNames}的写法，${platformName}推荐列表里没有对应的模型`,
            fix: { label: `改用 ${provider.defaultModel}`, model: provider.defaultModel }
          }
    }
  }

  if (platformModels) {
    const guess = guessPlatformModel(model, platformModels)
    if (!guess) {
      return { message: `${platformName}的模型列表里没有「${model}」，请确认名称是否正确` }
    }
    const notFound = `${platformName}的模型列表里没有「${model}」，可能应写作${guess.id}`
    // Offering a replacement that can't read screenshots would only trade one warning for another
    return guess.vision === false && requireVision
      ? { message: `${notFound}，但它不支持图片输入，无法识别截图` }
      : { message: notFound, fix: { label: '替换', model: guess.id } }
  }

  if (provider?.naming === 'prefixed' && !model.includes('/')) {
    return { message: `${platformName}的模型名需要带厂商前缀，形如${provider.defaultModel}` }
  }
  if (provider?.naming === 'bare' && model.includes('/')) {
    const bare = model.split('/').pop()!
    return {
      message: `${platformName}官方接口的模型名不带厂商前缀`,
      fix: { label: `改为 ${bare}`, model: bare }
    }
  }
  return null
}
