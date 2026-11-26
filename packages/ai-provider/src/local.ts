import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import {
  LocalLlmError,
  validateLocalToolCall,
  type LocalChatRequest,
  type HostEvent,
} from '@genoffice/local-llm/protocol'
import type { AiProviderConfig, AiChatResponse } from './types'
import type { StreamCallbacks } from './protocols/shared'
import { localChatText, localProgressText } from './local-copy'

/** Installed by the owning main/CLI process. No network fallback exists. */
export type LocalChatTransport = (
  config: AiProviderConfig,
  request: LocalChatRequest,
  event: (event: HostEvent) => void,
  signal: AbortSignal,
) => Promise<void>
let transport: LocalChatTransport | undefined
export function setLocalChatTransport(value: LocalChatTransport | undefined): void {
  transport = value
}

export async function streamLocal(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  if (messages.some((message) => message.role === 'user' && message.images?.length))
    throw new LocalLlmError('NOT_READY', localChatText().limits)
  if (!transport)
    throw new LocalLlmError('NOT_READY', `${localChatText().missing} — ${localChatText().title}`)
  await transport(
    config,
    {
      system,
      messages,
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      maxTokens,
      thinking: config.local?.thinking === true,
    },
    (event) => {
      cb.onActivity?.()
      switch (event.type) {
        case 'text':
          cb.onDelta(event.text)
          break
        case 'thought':
          cb.onReasoningDelta?.(event.text)
          break
        case 'toolcall':
          validateLocalToolCall(event.call, tools)
          cb.onToolCall(event.call)
          break
        case 'phase':
          cb.onStatus?.(localProgressText(event))
          break
        case 'usage':
          cb.onUsage?.({
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            thoughtsTokenCount: event.usage.thoughtTokens,
          })
          break
        case 'done':
          if (event.stopReason) cb.onStopReason?.(event.stopReason)
          break
      }
    },
    cb.signal,
  )
}

export async function chatLocal(
  config: AiProviderConfig,
  system: string,
  user: string,
  signal = new AbortController().signal,
): Promise<AiChatResponse> {
  let text = ''
  try {
    await streamLocal(config, system, [{ role: 'user', text: user }], [], 2048, {
      signal,
      onDelta: (delta) => {
        text += delta
      },
      onToolCall: () => {},
    })
    return { ok: true, content: text }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
