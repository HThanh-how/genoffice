import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import { chatOpenAiCompatible, streamOpenAiCompatible } from '../protocols/openai-compatible'
import type { StreamCallbacks } from '../protocols/shared'
import type { AiChatResponse, AiProviderConfig } from '../types'
import type { StreamWatchdog } from '../watchdog'
import { ensureLocalLlm, LocalLlmError, type LocalLlmEndpoint } from './llama-server-runtime'

/**
 * The `local-llama` protocol: wait for the managed llama-server, then speak plain
 * OpenAI-compatible chat completions to it. Node-only (it starts a process).
 *
 * Milestone 1 is text-only: llama-server runs without an mmproj and would reject image parts,
 * while the chat panels attach images without consulting the provider's vision flag, so images
 * are dropped here and the user turn says so. Tools are forwarded unchanged.
 */

export const IMAGE_OMITTED_NOTE = '[image omitted: the local model is text-only]'

/** Keepalive cadence while the model loads (the renderer's silence watchdog allows 240 s). */
const WAIT_ACTIVITY_MS = 5_000

export type EnsureLocalLlm = (
  config: AiProviderConfig,
  signal?: AbortSignal,
) => Promise<LocalLlmEndpoint>

/** User turns with their images replaced by a short text note. */
export function withoutImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.images?.length) return message
    const { images: _images, ...rest } = message
    return {
      ...rest,
      text: rest.text ? `${rest.text}\n\n${IMAGE_OMITTED_NOTE}` : IMAGE_OMITTED_NOTE,
    }
  })
}

/** Resolves with `promise`, calling `onActivity` regularly until it settles. */
async function withKeepalive<T>(promise: Promise<T>, onActivity?: () => void): Promise<T> {
  if (!onActivity) return promise
  onActivity()
  const timer = setInterval(onActivity, WAIT_ACTIVITY_MS)
  try {
    return await promise
  } finally {
    clearInterval(timer)
  }
}

function bearer(endpoint: LocalLlmEndpoint): Record<string, string> {
  return { Authorization: `Bearer ${endpoint.token}` }
}

export async function streamLocal(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  ensure: EnsureLocalLlm = ensureLocalLlm,
): Promise<void> {
  const endpoint = await withKeepalive(ensure(config, cb.signal), cb.onActivity)
  return streamOpenAiCompatible(
    endpoint.baseUrl,
    config,
    system,
    withoutImages(messages),
    tools,
    maxTokens,
    cb,
    { headers: bearer(endpoint) },
  )
}

export async function chatLocal(
  wd: StreamWatchdog,
  config: AiProviderConfig,
  system: string,
  user: string,
  ensure: EnsureLocalLlm = ensureLocalLlm,
): Promise<AiChatResponse> {
  let endpoint: LocalLlmEndpoint
  try {
    endpoint = await withKeepalive(ensure(config, wd.signal), () => wd.touch())
  } catch (error) {
    // configuration and start-up problems are a failed reply, like a bad base URL elsewhere
    if (error instanceof LocalLlmError) return { ok: false, error: error.message }
    throw error
  }
  return chatOpenAiCompatible(wd, endpoint.baseUrl, config, system, user, {
    headers: bearer(endpoint),
  })
}
