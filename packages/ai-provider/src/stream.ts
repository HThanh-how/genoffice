import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import { withOutputCapFallback } from './output-cap'
import { streamAnthropic } from './protocols/anthropic'
import { streamGemini } from './protocols/gemini'
import { streamOpenAiCompatible } from './protocols/openai-compatible'
import { streamCodexAppServer } from './codex-app-server'
import type { StreamCallbacks } from './protocols/shared'
import { getProviderAdapter, type AiProtocol } from './registry'
import type { AiProviderConfig, AiProviderId } from './types'

export { streamAnthropic } from './protocols/anthropic'
export { streamGemini } from './protocols/gemini'
export { streamOpenAiCompatible } from './protocols/openai-compatible'
export { AiCreditsError, sseLines } from './protocols/shared'
export type { StreamCallbacks } from './protocols/shared'

/** route a streaming, tool-calling-capable turn by provider id */
async function streamForProviderInner(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  if (provider === 'genspark') throw new Error('Genspark sign-in is disabled in this build')
  if (provider !== 'codex' && !config.model?.trim()) {
    throw new Error('Choose an AI model in Settings → AI Model')
  }
  if (provider === 'custom') {
    if (!config.baseUrl?.trim()) throw new Error('Set the Base URL in Settings → AI Model')
  } else if (provider !== 'codex' && !config.apiKey?.trim()) {
    throw new Error('Set an API key in Settings → AI Model')
  }
  const endpoint = getProviderAdapter(provider).resolveEndpoint(config)
  const { baseUrl } = endpoint
  if (endpoint.model) config = { ...config, model: endpoint.model }
  if (endpoint.protocol === 'codex-app-server') {
    return streamCodexAppServer(config, system, messages, tools, maxTokens, cb)
  }
  const protocol: Exclude<AiProtocol, 'codex-app-server'> = endpoint.protocol
  return withOutputCapFallback(baseUrl, config.model, maxTokens, (cap) => {
    switch (protocol) {
      case 'anthropic':
        return streamAnthropic(config, system, messages, tools, cap, cb, baseUrl)
      case 'gemini':
        return streamGemini(config, system, messages, tools, cap, cb, baseUrl, {
          omitTemperature: endpoint.omitTemperature,
        })
      case 'openai-compatible':
        return streamOpenAiCompatible(baseUrl, config, system, messages, tools, cap, cb, {
          omitTemperature: endpoint.omitTemperature,
          useMaxCompletionTokens: endpoint.useMaxCompletionTokens,
          bodyExtras: endpoint.bodyExtras,
        })
    }
  })
}

export interface AiErrorDiagnostic {
  timestamp: string
  provider: AiProviderId
  status: number | null
  category: 'rate-limit' | 'overloaded' | 'auth' | 'network' | 'other'
}
let errorLogger: ((record: AiErrorDiagnostic) => void) | null = null
export function setAiErrorLogger(logger: (record: AiErrorDiagnostic) => void): void {
  errorLogger = logger
}

/** Record metadata only. Provider bodies can contain credentials or document text. */
export async function streamForProvider(
  ...args: Parameters<typeof streamForProviderInner>
): Promise<void> {
  try {
    await streamForProviderInner(...args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof Error && error.name === 'AbortError')) {
      const match = /(?:HTTP|status|code)[ :="']+(\d{3})\b/i.exec(message)
      const status = match ? Number(match[1]) : null
      const category =
        status === 429 || /quota|rate.?limit|resource.exhausted/i.test(message)
          ? 'rate-limit'
          : status === 503 || status === 529 || /overload|unavailable|busy/i.test(message)
            ? 'overloaded'
            : status === 401 || status === 403
              ? 'auth'
              : /fetch failed|network|timeout|ECONN|ENOTFOUND/i.test(message)
                ? 'network'
                : 'other'
      try {
        errorLogger?.({ timestamp: new Date().toISOString(), provider: args[0], status, category })
      } catch {
        /* Diagnostics must never mask the provider failure. */
      }
    }
    throw error
  }
}
