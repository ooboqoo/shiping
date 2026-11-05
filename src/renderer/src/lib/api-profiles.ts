import { findProvider, knownVision } from './providers'
import type { ApiProfile, ReasoningEffort } from '../../../shared/api-profile'

export type { ApiProfile, ReasoningEffort }

/** 「思考强度」 as the settings page and the profile tags name it */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  '': '默认',
  low: '低',
  medium: '中',
  high: '高'
}

/**
 * The profile's thinking setting as a short tag (「关闭思考」 / 「思考强度：高」),
 * or nothing when it is left to the model
 */
export function thinkingTag(profile: ApiProfile): string {
  if (profile.disableThinking) return '关闭思考'
  if (profile.reasoningEffort)
    return `思考强度：${REASONING_EFFORT_LABELS[profile.reasoningEffort]}`
  return ''
}

let profileSeq = 0

/** Ids only need to be unique within one installation, so a counter suffices */
export function createProfileId(): string {
  profileSeq += 1
  return `profile-${Date.now().toString(36)}-${profileSeq}`
}

export function createProfile(partial?: Partial<ApiProfile>): ApiProfile {
  const baseURL = partial?.apiBaseURL ?? ''
  const model = partial?.model ?? findProvider(baseURL)?.defaultModel ?? ''
  return {
    id: createProfileId(),
    name: partial?.name || '新配置',
    apiBaseURL: baseURL,
    apiKey: partial?.apiKey ?? '',
    apiHeaders: partial?.apiHeaders ?? '',
    model,
    disableThinking: partial?.disableThinking ?? false,
    reasoningEffort: partial?.reasoningEffort ?? '',
    vision: partial?.vision ?? knownVision(model)
  }
}
