import { knownVision } from './providers'
import type { ApiProfile } from '../../../shared/api-profile'

export type { ApiProfile }

let profileSeq = 0

/** Ids only need to be unique within one installation, so a counter suffices */
export function createProfileId(): string {
  profileSeq += 1
  return `profile-${Date.now().toString(36)}-${profileSeq}`
}

export function createProfile(partial?: Partial<ApiProfile>): ApiProfile {
  const baseURL = partial?.apiBaseURL ?? ''
  const model = partial?.model ?? ''
  return {
    id: createProfileId(),
    name: partial?.name || '新配置',
    apiBaseURL: baseURL,
    apiKey: partial?.apiKey ?? '',
    apiHeaders: partial?.apiHeaders ?? '',
    model,
    disableThinking: partial?.disableThinking ?? false,
    vision: partial?.vision ?? knownVision(model)
  }
}
