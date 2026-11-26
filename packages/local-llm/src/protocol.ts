export type LocalErrorCode =
  | 'MODEL_MISSING'
  | 'MODEL_CHECKSUM'
  | 'MODEL_SIZE'
  | 'INSUFFICIENT_RAM'
  | 'NATIVE_CRASH'
  | 'ABORTED'
  | 'CONTEXT_OVERFLOW'
  | 'BUSY'
  | 'NOT_READY'
  | 'INVALID_TOOL'
  | 'RUNTIME'
  /** not a failure: the model is still being downloaded or checked; the message is a status line */
  | 'PREPARING'

/** What the runtime is really doing; every step is reported as it begins, none is timed or guessed. */
export type LocalPhase = 'starting' | 'checking' | 'loading' | 'preparing' | 'reading' | 'writing'
export interface LocalProgress {
  phase: LocalPhase
  /** only where the runtime measures it (reading the weights into memory) */
  percent?: number
}

export class LocalLlmError extends Error {
  constructor(
    readonly code: LocalErrorCode,
    message: string,
  ) {
    super(message)
    this.name = code === 'ABORTED' ? 'AbortError' : 'LocalLlmError'
  }
}

export interface LocalOptions {
  gpu: 'cpu' | 'auto' | 'vulkan'
  threads: number
  contextSize: number
  keepHotMinutes: number
  thinking: boolean
  autoDownload: boolean
}

export const DEFAULT_LOCAL_OPTIONS: LocalOptions = {
  gpu: 'cpu',
  threads: 6,
  contextSize: 16384,
  keepHotMinutes: 10,
  thinking: false,
  autoDownload: true,
}

export function localOptions(value?: Partial<LocalOptions>): LocalOptions {
  const bounded = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n)
      ? Math.max(min, Math.min(max, Math.floor(n)))
      : fallback
  return {
    gpu: value?.gpu === 'auto' || value?.gpu === 'vulkan' ? value.gpu : 'cpu',
    threads: bounded(value?.threads, DEFAULT_LOCAL_OPTIONS.threads, 1, 64),
    contextSize: bounded(value?.contextSize, 16384, 2048, 32768),
    keepHotMinutes: bounded(value?.keepHotMinutes, 10, 0, 120),
    thinking: value?.thinking === true,
    autoDownload: value?.autoDownload !== false,
  }
}

export interface LocalTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
export interface LocalToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}
export type LocalMessage =
  | { role: 'user'; text: string }
  | {
      role: 'assistant'
      text: string
      reasoning?: string | undefined
      toolCalls?: LocalToolCall[] | undefined
    }
  | {
      role: 'tool'
      results: { id: string; name: string; output: string; isError?: boolean | undefined }[]
    }
export interface LocalChatRequest {
  system: string
  messages: LocalMessage[]
  tools: LocalTool[]
  maxTokens: number
  thinking?: boolean
  sampling?: Partial<{
    temperature: number
    topK: number
    topP: number
    minP: number
    repeatPenalty: number
  }>
}
export type HostRequest =
  | { id: string; type: 'load'; modelPath: string; options: LocalOptions }
  | { id: string; type: 'chat'; request: LocalChatRequest }
  | { id: string; type: 'abort'; requestId: string }
  | { id: string; type: 'unload' | 'status' | 'ping' | 'shutdown' }
export interface LocalUsage {
  inputTokens: number
  outputTokens: number
  evaluatedPromptTokens: number
  thoughtTokens: number
  elapsedMs: number
  ttftMs: number | null
  rssBytes: number
}
export type HostEvent =
  | { id: string; type: 'text' | 'thought'; text: string }
  | { id: string; type: 'toolcall'; call: LocalToolCall }
  | ({ id: string; type: 'phase' } & LocalProgress)
  | { id: string; type: 'usage'; usage: LocalUsage }
  | { id: string; type: 'done'; stopReason?: string }
  | {
      id: string
      type: 'status'
      loaded: boolean
      busy: boolean
      contextSize?: number
      loadTimings?: { verifyMs: number; backendMs: number; modelMs: number; contextMs: number }
      rssBytes: number
    }
  | { id: string; type: 'error'; code: LocalErrorCode; message: string }

/** Both the host and provider enforce the exact per-turn grant. Never synthesize arguments. */
export function validateLocalToolCall(call: LocalToolCall, tools: readonly LocalTool[]): void {
  if (!tools.some((tool) => tool.name === call.name))
    throw new LocalLlmError('INVALID_TOOL', `Tool is not granted: ${call.name}`)
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input))
    throw new LocalLlmError('INVALID_TOOL', 'Tool arguments must be an object')
  if (
    call.name === 'deleteBlocks' &&
    (!call.input.target ||
      typeof call.input.target !== 'object' ||
      Array.isArray(call.input.target) ||
      Object.keys(call.input.target).length === 0)
  ) {
    throw new LocalLlmError('INVALID_TOOL', 'deleteBlocks requires an explicit target')
  }
}
