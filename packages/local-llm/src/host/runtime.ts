import { freemem, totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  getLlama,
  LlamaChat,
  LlamaLogLevel,
  type Llama,
  type LlamaModel,
  type LlamaContext,
  type ChatHistoryItem,
  type ChatModelFunctions,
  type GbnfJsonSchema,
} from 'node-llama-cpp'
import { contextBudget } from '../budget'
import { verifyModel } from '../integrity'
import { LFM_SAMPLING } from '../manifest'
import {
  LocalLlmError,
  validateLocalToolCall,
  type HostEvent,
  type HostRequest,
  type LocalChatRequest,
} from '../protocol'

export class NativeHost {
  private llama?: Llama
  private model?: LlamaModel
  private context?: LlamaContext
  private chat?: LlamaChat
  private active?: { id: string; controller: AbortController }
  private loading?: Promise<void>
  private closing = false

  constructor(
    private readonly send: (message: HostEvent) => void,
    private readonly exit: () => void,
  ) {}

  async receive(message: HostRequest): Promise<void> {
    const { id } = message
    try {
      switch (message.type) {
        case 'abort':
          if (this.active?.id === message.requestId)
            this.active.controller.abort(new LocalLlmError('ABORTED', 'Local generation cancelled'))
          break
        case 'load':
          if (this.closing || this.active || this.loading)
            throw new LocalLlmError('BUSY', 'Local host is busy')
          this.loading = (async () => {
            if (this.model) return
            let checkpoint = performance.now()
            const size = contextBudget(freemem(), totalmem(), message.options.contextSize)
            this.send({ id, type: 'phase', phase: 'checking' })
            await verifyModel(message.modelPath)
            const verifyMs = performance.now() - checkpoint
            checkpoint = performance.now()
            if (this.closing) throw new LocalLlmError('ABORTED', 'Local startup cancelled')
            this.llama = await getLlama({
              gpu: message.options.gpu === 'cpu' ? false : message.options.gpu,
              logLevel: LlamaLogLevel.error,
              build: 'never',
              skipDownload: true,
              maxThreads: message.options.threads,
            })
            const backendMs = performance.now() - checkpoint
            checkpoint = performance.now()
            this.send({ id, type: 'phase', phase: 'loading', percent: 0 })
            let reported = 0
            this.model = await this.llama.loadModel({
              modelPath: message.modelPath,
              gpuLayers: message.options.gpu === 'cpu' ? 0 : 'auto',
              onLoadProgress: (progress) => {
                const percent = Math.floor(progress * 20) * 5
                if (percent <= reported) return
                reported = percent
                this.send({ id, type: 'phase', phase: 'loading', percent })
              },
            })
            const modelMs = performance.now() - checkpoint
            checkpoint = performance.now()
            this.send({ id, type: 'phase', phase: 'preparing' })
            this.context = await this.model.createContext({
              contextSize: size,
              threads: message.options.threads,
              sequences: 1,
            })
            this.chat = new LlamaChat({ contextSequence: this.context.getSequence() })
            this.send({
              id,
              type: 'status',
              loaded: true,
              busy: false,
              contextSize: size,
              rssBytes: process.memoryUsage().rss,
              loadTimings: {
                verifyMs,
                backendMs,
                modelMs,
                contextMs: performance.now() - checkpoint,
              },
            })
          })()
          try {
            await this.loading
          } finally {
            this.loading = undefined
          }
          break
        case 'chat':
          if (this.closing || this.active || this.loading)
            throw new LocalLlmError('BUSY', 'Local host is busy')
          if (!this.chat) throw new LocalLlmError('NOT_READY', 'Local model has not been loaded')
          this.active = { id, controller: new AbortController() }
          try {
            await this.generate(id, message.request, this.active.controller.signal)
          } finally {
            this.active = undefined
          }
          return
        case 'unload':
          if (this.active || this.loading)
            throw new LocalLlmError('BUSY', 'Cannot unload a busy local model')
          await this.dispose()
          break
        case 'shutdown':
          this.closing = true
          this.active?.controller.abort(new LocalLlmError('ABORTED', 'Local host is stopping'))
          await this.loading?.catch(() => {})
          // Wait for the inference finally block before releasing native handles.
          while (this.active) await new Promise((resolve) => setTimeout(resolve, 10))
          await this.dispose()
          this.exit()
          return
        case 'status':
        case 'ping':
          this.send({
            id,
            type: 'status',
            loaded: !!this.model,
            busy: !!this.active || !!this.loading,
            contextSize: this.context?.contextSize,
            rssBytes: process.memoryUsage().rss,
          })
          break
      }
      this.send({ id, type: 'done' })
    } catch (error) {
      this.send({
        id,
        type: 'error',
        code:
          error instanceof LocalLlmError
            ? error.code
            : /not enough.*(memory|ram)|insufficient.*(memory|ram)|memory allocation/i.test(
                  String(error),
                )
              ? 'INSUFFICIENT_RAM'
              : 'RUNTIME',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async generate(
    id: string,
    request: LocalChatRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const chat = this.chat!
    const history: ChatHistoryItem[] = [{ type: 'system', text: request.system }]
    const results = new Map(
      request.messages.flatMap((message) =>
        message.role === 'tool' ? message.results.map((r) => [r.id, r] as const) : [],
      ),
    )
    for (const message of request.messages) {
      if (message.role === 'user') history.push({ type: 'user', text: message.text })
      if (message.role === 'assistant') {
        history.push({
          type: 'model',
          response: [
            ...(message.reasoning
              ? [
                  {
                    type: 'segment' as const,
                    segmentType: 'thought' as const,
                    text: message.reasoning,
                    ended: true,
                  },
                ]
              : []),
            ...(message.text ? [message.text] : []),
            ...(message.toolCalls ?? []).map((call) => ({
              type: 'functionCall' as const,
              name: call.name,
              params: call.input,
              result: results.get(call.id)?.output ?? 'Tool result unavailable',
            })),
          ],
        })
      }
    }
    history.push({ type: 'model', response: [] })
    const functions: ChatModelFunctions = Object.fromEntries(
      request.tools.map((tool) => [
        tool.name,
        { description: tool.description, params: tool.inputSchema as GbnfJsonSchema },
      ]),
    )
    const prompt = chat.chatWrapper.generateContextState({
      chatHistory: history,
      availableFunctions: functions,
    }).contextText
    const inputTokens = prompt.tokenize(this.model!.tokenizer).length
    const room = this.context!.contextSize - inputTokens - 32
    if (room < 128)
      throw new LocalLlmError(
        'CONTEXT_OVERFLOW',
        `Local context exceeded: ${inputTokens} prompt tokens / ${this.context!.contextSize}. Shorten the conversation or increase context in Settings.`,
      )
    const maxTokens = Math.min(Math.max(1, Math.floor(request.maxTokens || 2048)), 16384, room)
    const started = performance.now()
    let ttft: number | null = null
    let thoughtTokens = 0
    const before = chat.sequence.tokenMeter.getState()
    const sampling = { ...LFM_SAMPLING, ...request.sampling }
    this.send({ id, type: 'phase', phase: 'reading' })
    // The first text, or the first piece of a tool call, means the prompt has been read. (An empty
    // chunk arrives before reading starts, so a chunk alone proves nothing.)
    let writing = false
    const noteWriting = () => {
      if (writing) return
      writing = true
      this.send({ id, type: 'phase', phase: 'writing' })
    }
    const result = await chat.generateResponse(history, {
      ...sampling,
      repeatPenalty: { penalty: sampling.repeatPenalty },
      functions,
      maxTokens,
      budgets: { thoughtTokens: request.thinking ? Math.min(4096, Math.floor(room / 2)) : 0 },
      signal,
      contextShift: {
        strategy: () => {
          throw new LocalLlmError(
            'CONTEXT_OVERFLOW',
            'Local context exhausted. Shorten the conversation.',
          )
        },
      },
      onFunctionCallParamsChunk: noteWriting,
      onResponseChunk: (chunk) => {
        if (chunk.text) noteWriting()
        if (chunk.type === 'segment') {
          if (chunk.segmentType === 'thought') {
            thoughtTokens += chunk.tokens.length
            if (chunk.text) this.send({ id, type: 'thought', text: chunk.text })
          }
        } else if (chunk.text) {
          ttft ??= performance.now() - started
          this.send({ id, type: 'text', text: chunk.text })
        }
      },
    })
    signal.throwIfAborted()
    for (const call of result.functionCalls ?? []) {
      const normalized = {
        id: randomUUID(),
        name: call.functionName,
        input: call.params as unknown as Record<string, unknown>,
      }
      validateLocalToolCall(normalized, request.tools)
      this.send({ id, type: 'toolcall', call: normalized })
    }
    const after = chat.sequence.tokenMeter.getState()
    this.send({
      id,
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens: after.usedOutputTokens - before.usedOutputTokens,
        evaluatedPromptTokens: after.usedInputTokens - before.usedInputTokens,
        thoughtTokens,
        elapsedMs: performance.now() - started,
        ttftMs: ttft,
        rssBytes: process.memoryUsage().rss,
      },
    })
    this.send({
      id,
      type: 'done',
      stopReason:
        result.metadata.stopReason === 'maxTokens' ? 'max_tokens' : result.metadata.stopReason,
    })
  }

  private async dispose(): Promise<void> {
    this.chat?.dispose()
    this.chat = undefined
    await this.context?.dispose()
    this.context = undefined
    await this.model?.dispose()
    this.model = undefined
    await this.llama?.dispose()
    this.llama = undefined
  }
}
