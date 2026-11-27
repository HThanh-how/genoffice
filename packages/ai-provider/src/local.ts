import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import {
  LocalLlmError,
  validateLocalToolCall,
  type LocalChatRequest,
  type HostEvent,
} from '@genoffice/local-llm/protocol'
import type { AiProviderConfig, AiChatResponse } from './types'
import type { StreamCallbacks } from './protocols/shared'
import { localChatText } from './local-copy'
import { diagHook } from './diag-hook'

// LFM can finish a Home search with just `[file:0]`. The citation renderer drops that unknown
// id, so non-empty raw output is not necessarily an answer. Keep these prefixes buffered until
// prose arrives; an unsuccessful attempt must not leak into the retry's streamed answer.
function hasReplyText(text: string): boolean {
  return !!text
    .replace(/\[\[?\s*(?:(?:file|files|tệp|tep|id)\s*[:#]?\s*)?\d+(?:[\s,;&\d]*)\]\]?(?!\()/giu, '')
    .trim()
}

const RETRY_INSTRUCTION =
  '\n\nReply to the latest user request in plain sentences in the user’s language. Use existing tool results as evidence only; if they do not match the request, say no matching file was found. Do not output file citation markers or call tools. Do not claim actions succeeded without a confirming tool result.'

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
  const request: LocalChatRequest = {
    system,
    messages,
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    maxTokens,
    thinking: config.local?.thinking === true,
  }
  let usage: { inputTokens: number; outputTokens: number; thoughtsTokenCount: number } | undefined
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      cb.signal.throwIfAborted()
      let text = ''
      let streamed = false
      let toolCalls = 0
      let stopReason: string | undefined
      let invalidTool = false
      try {
        await transport(
          config,
          attempt === 0
            ? request
            : {
                ...request,
                system: system + RETRY_INSTRUCTION,
                tools: [],
              },
          (event) => {
            cb.onActivity?.()
            switch (event.type) {
              case 'text': {
                text += event.text
                if (streamed) cb.onDelta(event.text)
                else if (
                  hasReplyText(text) &&
                  !(text.trimStart().startsWith('[') && !text.includes(']'))
                ) {
                  streamed = true
                  cb.onDelta(text)
                }
                break
              }
              case 'thought':
                cb.onReasoningDelta?.(event.text)
                break
              case 'toolcall':
                validateLocalToolCall(event.call, attempt === 0 ? tools : [])
                toolCalls++
                cb.onToolCall(event.call)
                break
              case 'usage':
                usage ??= { inputTokens: 0, outputTokens: 0, thoughtsTokenCount: 0 }
                usage.inputTokens += event.usage.inputTokens
                usage.outputTokens += event.usage.outputTokens
                usage.thoughtsTokenCount += event.usage.thoughtTokens
                break
              case 'done':
                stopReason = event.stopReason
                break
            }
          },
          cb.signal,
        )
      } catch (error) {
        if (
          !(error instanceof LocalLlmError) ||
          error.code !== 'INVALID_TOOL' ||
          streamed ||
          toolCalls
        )
          throw error
        invalidTool = true
      }
      cb.signal.throwIfAborted()
      if (toolCalls || (!invalidTool && hasReplyText(text))) {
        if (!streamed && text) cb.onDelta(text)
        if (stopReason) cb.onStopReason?.(stopReason)
        return
      }
      diagHook.warn('ai', 'local.no-reply', {
        attempt: attempt + 1,
        reason: invalidTool ? 'invalid_tool' : text.trim() ? 'citation_only' : 'empty',
        tools: attempt === 0 ? tools.length : 0,
      })
    }
    throw new LocalLlmError('RUNTIME', localChatText().noReply)
  } finally {
    if (usage) cb.onUsage?.(usage)
  }
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
