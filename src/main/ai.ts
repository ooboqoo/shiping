import { streamText, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { settings, getModeProfile } from './settings'
import { DEFAULT_API_BASE_URL, type ApiProfile, type AppMode } from '../shared/api-profile'
import { buildRequestHeaders } from '../shared/request-headers'
import { createReasoningEffortFetch, createThinkingOffFetch } from './thinking'
import { apiFetch } from './api-fetch'
import { getKnowledgePrompt } from './knowledge'
import { getExternalReference, withReference } from './external-knowledge'
import type { StreamChunk } from './stream'

// The system prompts are fully managed by the renderer (prompt scenes in the
// settings store, one active scene per mode) and synced here via
// updateAppSettings on app startup. The mode's 资料库 material goes first
function getSystemPrompt(mode: AppMode, extra?: string) {
  const prompt = mode === 'screenshot' ? settings.customPrompt : settings.conversationPrompt
  return [getKnowledgePrompt(mode), prompt, extra].filter(Boolean).join('\n\n') || undefined
}

/** Tell the user once that the active model ignores the profile's 「关闭思考」 */
function reportThinkingRefused(model: string) {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('thinking-unsupported', model)
}

/** Tell the user once that the active model refused the profile's 「思考强度」 */
function reportEffortRefused(model: string) {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('reasoning-effort-unsupported', model)
}

/** 「关闭思考」 wins over 「思考强度」: thinking that is off has no strength */
function createFetch(profile: ApiProfile): typeof fetch {
  if (profile.disableThinking) {
    return createThinkingOffFetch(profile.apiBaseURL, reportThinkingRefused, apiFetch)
  }
  if (profile.reasoningEffort) {
    return createReasoningEffortFetch(
      profile.apiBaseURL,
      profile.reasoningEffort,
      reportEffortRefused,
      apiFetch
    )
  }
  return apiFetch
}

function createProvider(profile: ApiProfile) {
  // The app only ever talks OpenAI-compatible chat-completions; this provider
  // also surfaces thinking models' reasoning (`reasoning_content` / `reasoning`
  // deltas) as reasoning stream parts, which @ai-sdk/openai drops. It has no
  // default base URL, so an empty one means OpenAI here as everywhere else
  return createOpenAICompatible({
    name: 'shiping',
    baseURL: profile.apiBaseURL.trim() || DEFAULT_API_BASE_URL,
    apiKey: profile.apiKey,
    headers: buildRequestHeaders(profile.apiKey, profile.apiHeaders),
    fetch: createFetch(profile)
  })
}

function getModel(profile: ApiProfile) {
  const fallbackModel = profile.apiBaseURL.includes('siliconflow')
    ? 'Qwen/Qwen3-VL-32B-Instruct'
    : 'gpt-5-mini'
  return profile.model || fallbackModel
}

/**
 * One chunk at a time, tagged reasoning or answer text, so callers can route
 * them to their own events. Other stream parts (tool calls, sources, …) are
 * not produced with the plain chat setup and are dropped here.
 */
async function* streamChunks(
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>
): AsyncIterable<StreamChunk> {
  for await (const event of fullStream) {
    if (event.type === 'reasoning-delta') yield { kind: 'reasoning', delta: event.text }
    else if (event.type === 'text-delta') yield { kind: 'text', delta: event.text }
  }
}

/**
 * `query` is what this round asks in words (a follow-up, the transcription,
 * the other side's sentences), for the 外部知识库 to search with; its
 * passages are awaited before the model is asked, and stay out of `messages`
 */
async function* streamWith(
  mode: AppMode,
  messages: ModelMessage[],
  abortSignal: AbortSignal | undefined,
  {
    query,
    extraSystem,
    system = getSystemPrompt(mode, extraSystem)
  }: { query?: string; extraSystem?: string; system?: string } = {}
): AsyncIterable<StreamChunk> {
  const reference = await getExternalReference(mode, query, abortSignal)
  const profile = getModeProfile(mode)
  const openai = createProvider(profile)

  const { fullStream } = streamText({
    model: openai.chatModel(getModel(profile)),
    system,
    messages: withReference(messages, reference),
    abortSignal,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  yield* streamChunks(fullStream)
}

/** `query`: the transcription sent with the screenshot, if any */
export function getSolutionStream(
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
  query?: string
) {
  return streamWith('screenshot', messages, abortSignal, { query })
}

export function getFollowUpStream(
  messages: ModelMessage[],
  userQuestion: string,
  abortSignal?: AbortSignal
) {
  // Add the user's follow-up question to the conversation
  const updatedMessages: ModelMessage[] = [
    ...messages,
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userQuestion
        }
      ]
    }
  ]
  return streamWith('screenshot', updatedMessages, abortSignal, { query: userQuestion })
}

/** `query`: the transcription sent with the appended screenshot, if any */
export function getGeneralStream(
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
  query?: string
) {
  return streamWith('screenshot', messages, abortSignal, {
    query,
    extraSystem: '注意：如果有多张截图，请结合所有截图内容进行完整分析，不要遗漏任何部分。'
  })
}

/**
 * 对话模式: a hint for what the other side just said, with the conversation
 * profile. `query`: those sentences, for the 外部知识库
 */
export function getHintStream(messages: ModelMessage[], abortSignal?: AbortSignal, query?: string) {
  return streamWith('conversation', messages, abortSignal, { query })
}

/**
 * 对话模式's system prompt sent ahead of the hints, so the platform has it
 * cached (资料库 first, then the scene: the bytes every hint starts with) and
 * the first hint of a call prefills faster. The caller cuts it off at the
 * first chunk; nothing it says is used.
 */
export function getPrewarmStream(abortSignal?: AbortSignal) {
  return streamWith('conversation', [{ role: 'user', content: '好' }], abortSignal)
}

/** 对话模式's rolling memo (conversation.ts): its own instructions, without 资料库 or scene */
export function getMemoStream(system: string, prompt: string, abortSignal?: AbortSignal) {
  return streamWith('conversation', [{ role: 'user', content: prompt }], abortSignal, { system })
}
