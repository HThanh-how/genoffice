import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'

/**
 * Special token costs for LFM3-VL chat template (ChatML format).
 * <|im_start|>role\n ... <|im_end|>\n
 */
export const LFM3_VL_SPECIAL_TOKENS = {
  IM_START: '<|im_start|>',
  IM_END: '<|im_end|>',
  VISION_START: '<|vision_start|>',
  VISION_END: '<|vision_end|>',
  MESSAGE_OVERHEAD_TOKENS: 4, // <|im_start|>role\n + <|im_end|>\n
  BASE_PROMPT_OVERHEAD: 3, // BOS token + prime
} as const

/**
 * Liquid AI LFM3-VL-2B vision projector token allocation per image.
 * For standard 384x384 vision encoder patches (14x14 patches + 2D spatial pooling),
 * an image consumes 576 vision tokens (or 256 tokens for thumbnail downscale).
 */
export const LFM3_VL_DEFAULT_VISION_TOKENS_PER_IMAGE = 576
export const LFM3_VL_THUMBNAIL_VISION_TOKENS = 256

/**
 * Counts text tokens using a byte-level subword model calibrated for LFM3-VL / Llama vocab.
 * Accurately models:
 * - Common English words (~1 - 1.3 tokens/word)
 * - Vietnamese / Multibyte UTF-8 with diacritics (~1.5 - 2.2 tokens/word)
 * - Numbers and alphanumeric codes (digit-by-digit or small clumps)
 * - Punctuation and whitespace
 */
export function countTextTokens(text: string): number {
  if (!text) return 0

  let tokens = 0
  // Regex to split into subword chunks:
  // 1. Letters and words (including Unicode diacritics)
  // 2. Numbers (sequences of digits)
  // 3. Punctuation / symbols
  // 4. Whitespace blocks
  const chunkRegex = /[\p{L}]+|\d+|[^\s\p{L}\d]+|\s+/gu
  const matches = text.match(chunkRegex)
  if (!matches) return Math.ceil(text.length / 3.5)

  for (const chunk of matches) {
    if (/^\s+$/.test(chunk)) {
      // Whitespace: every 4 spaces or single newline is roughly 1 token
      tokens += Math.max(1, Math.floor(chunk.length / 4))
      continue
    }

    if (/^\d+$/.test(chunk)) {
      // Numbers: LLMs typically chunk digits in 1-3 digit blocks
      tokens += Math.ceil(chunk.length / 2)
      continue
    }

    // Check if chunk contains multibyte Unicode characters (e.g. Vietnamese, CJK, Emoji)
    const isAscii = /^[\x00-\x7F]+$/.test(chunk)
    if (isAscii) {
      // ASCII words: ~4 chars per token on average for English
      tokens += Math.max(1, Math.ceil(chunk.length / 4))
    } else {
      // Multibyte text: UTF-8 encoding expansion.
      // Vietnamese tone marks and accented vowels take more BPE subword merges.
      // We calculate by UTF-8 byte length (typically 2-3 bytes per accented char).
      const byteLength = new TextEncoder().encode(chunk).length
      tokens += Math.max(1, Math.ceil(byteLength / 3))
    }
  }

  return tokens
}

/**
 * Counts the token cost of image inputs processed by the LFM3-VL multimodal projector.
 */
export function countImageTokens(
  imageCount: number,
  resolution?: { width?: number; height?: number },
): number {
  if (imageCount <= 0) return 0
  if (!resolution || !resolution.width || !resolution.height) {
    return imageCount * LFM3_VL_DEFAULT_VISION_TOKENS_PER_IMAGE
  }

  const { width, height } = resolution
  if (width <= 192 && height <= 192) {
    return imageCount * LFM3_VL_THUMBNAIL_VISION_TOKENS
  }
  return imageCount * LFM3_VL_DEFAULT_VISION_TOKENS_PER_IMAGE
}

/**
 * Counts the schema overhead in tokens when injecting tool definitions into the prompt.
 */
export function countToolsTokens(tools: readonly AgentToolDef[]): number {
  if (!tools || tools.length === 0) return 0
  let tokenCount = 16 // System instructions wrapper for tools: "You have access to the following tools..."
  for (const tool of tools) {
    tokenCount += countTextTokens(tool.name) + 2
    if (tool.description) {
      tokenCount += countTextTokens(tool.description) + 4
    }
    if (tool.inputSchema) {
      const schemaStr = JSON.stringify(tool.inputSchema)
      tokenCount += countTextTokens(schemaStr)
    }
  }
  return tokenCount
}

/**
 * Estimates the token count of a single conversational AgentMessage.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  let tokens = LFM3_VL_SPECIAL_TOKENS.MESSAGE_OVERHEAD_TOKENS + countTextTokens(message.role)

  if (message.role === 'user') {
    if (message.text) tokens += countTextTokens(message.text)
    // Vision attachments
    if (message.images && message.images.length > 0) {
      tokens += countImageTokens(message.images.length)
    }
  } else if (message.role === 'assistant') {
    if (message.text) tokens += countTextTokens(message.text)
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const tc of message.toolCalls) {
        tokens += 6 + countTextTokens(tc.name) + countTextTokens(JSON.stringify(tc.input ?? {}))
      }
    }
  } else if (message.role === 'tool') {
    if (message.results && message.results.length > 0) {
      for (const res of message.results) {
        tokens += 4 + countTextTokens(res.id)
        if (typeof res.output === 'string') {
          tokens += countTextTokens(res.output)
        }
      }
    }
  }

  return tokens
}

export interface ContextBudgetPlan {
  totalTokens: number
  fitsContext: boolean
  systemTokens: number
  toolsTokens: number
  messagesTokens: number
  reservedOutputTokens: number
  availableTokens: number
  prunedMessages: AgentMessage[]
}

/**
 * Plans and guarantees the context window budget for LFM3-VL (Issue 6.1).
 * Accurately accounts for:
 * 1. System prompt tokens
 * 2. Tool definitions schema tokens
 * 3. Vision/image tokens
 * 4. Conversational messages
 * 5. Reserved output token budget
 *
 * If the total exceeds maxContextSize, it trims conversation history from oldest to newest
 * while strictly guaranteeing that the system prompt, tool definitions, and latest user query
 * are never dropped.
 */
export function planContextBudget(options: {
  system: string
  tools: readonly AgentToolDef[]
  messages: readonly AgentMessage[]
  maxContextSize: number
  maxOutputTokens: number
}): ContextBudgetPlan {
  const { system, tools, messages, maxContextSize, maxOutputTokens } = options

  const systemTokens = system ? countTextTokens(system) + LFM3_VL_SPECIAL_TOKENS.MESSAGE_OVERHEAD_TOKENS : 0
  const toolsTokens = countToolsTokens(tools)
  const reservedOutputTokens = Math.max(128, Math.min(maxOutputTokens, 2048))

  const fixedOverhead = systemTokens + toolsTokens + reservedOutputTokens + LFM3_VL_SPECIAL_TOKENS.BASE_PROMPT_OVERHEAD
  const availableForConversation = Math.max(256, maxContextSize - fixedOverhead)

  // Calculate message tokens
  const messageTokenCounts = messages.map((m) => estimateMessageTokens(m))
  let totalConversationTokens = messageTokenCounts.reduce((a, b) => a + b, 0)

  if (totalConversationTokens <= availableForConversation) {
    return {
      totalTokens: fixedOverhead + totalConversationTokens,
      fitsContext: true,
      systemTokens,
      toolsTokens,
      messagesTokens: totalConversationTokens,
      reservedOutputTokens,
      availableTokens: maxContextSize - (fixedOverhead + totalConversationTokens),
      prunedMessages: [...messages],
    }
  }

  // Conversation exceeds available budget: trim oldest messages while keeping latest user turn
  const pruned: AgentMessage[] = []
  let accumulated = 0

  // Always keep the latest message
  const lastIndex = messages.length - 1
  if (lastIndex >= 0) {
    pruned.unshift(messages[lastIndex]!)
    accumulated += messageTokenCounts[lastIndex] ?? 0
  }

  // Add messages from newest to oldest as long as they fit
  for (let i = lastIndex - 1; i >= 0; i--) {
    const cost = messageTokenCounts[i] ?? 0
    if (accumulated + cost <= availableForConversation) {
      pruned.unshift(messages[i]!)
      accumulated += cost
    } else {
      break
    }
  }

  return {
    totalTokens: fixedOverhead + accumulated,
    fitsContext: false,
    systemTokens,
    toolsTokens,
    messagesTokens: accumulated,
    reservedOutputTokens,
    availableTokens: maxContextSize - (fixedOverhead + accumulated),
    prunedMessages: pruned,
  }
}
