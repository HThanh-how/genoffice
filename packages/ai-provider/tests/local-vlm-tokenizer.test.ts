import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import {
  countImageTokens,
  countTextTokens,
  countToolsTokens,
  estimateMessageTokens,
  LFM3_VL_DEFAULT_VISION_TOKENS_PER_IMAGE,
  LFM3_VL_THUMBNAIL_VISION_TOKENS,
  planContextBudget,
} from '../src/local-vlm-tokenizer'

describe('Local VLM Tokenizer (Issue 6.1)', () => {
  it('accurately counts ASCII text, numbers, and whitespace tokens', () => {
    expect(countTextTokens('')).toBe(0)
    expect(countTextTokens('hello world')).toBeGreaterThanOrEqual(2)
    // Numbers
    expect(countTextTokens('1234567890')).toBeGreaterThanOrEqual(3)
    // Multi-line whitespace
    expect(countTextTokens('\n\n\n\n')).toBeGreaterThanOrEqual(1)
  })

  it('accurately counts multibyte Vietnamese text with diacritics', () => {
    const vnText = 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM'
    const tokens = countTextTokens(vnText)
    // Vietnamese with tone marks produces more subword tokens than plain ASCII
    expect(tokens).toBeGreaterThan(6)
  })

  it('calculates vision tokens for images based on resolution', () => {
    expect(countImageTokens(0)).toBe(0)
    // Standard patch resolution
    expect(countImageTokens(1)).toBe(LFM3_VL_DEFAULT_VISION_TOKENS_PER_IMAGE)
    expect(countImageTokens(2)).toBe(LFM3_VL_DEFAULT_VISION_TOKENS_PER_IMAGE * 2)

    // Thumbnail downscale
    expect(countImageTokens(1, { width: 128, height: 128 })).toBe(LFM3_VL_THUMBNAIL_VISION_TOKENS)
  })

  it('calculates token budget overhead for tool definitions', () => {
    const sampleTools: AgentToolDef[] = [
      {
        name: 'read_blocks',
        description: 'Read a slice of document blocks by index range.',
        inputSchema: {
          type: 'object',
          properties: {
            startBlockIndex: { type: 'number' },
            endBlockIndex: { type: 'number' },
          },
          required: ['startBlockIndex', 'endBlockIndex'],
        },
      },
    ]

    const tokens = countToolsTokens(sampleTools)
    expect(tokens).toBeGreaterThan(30)
  })

  it('estimates conversational message token cost including images and tool calls', () => {
    const userMsgWithImage: AgentMessage = {
      role: 'user',
      text: 'Trích xuất hóa đơn này',
      images: [{ base64: 'dGVzdA==', mime: 'image/jpeg' }],
    }
    const cost = estimateMessageTokens(userMsgWithImage)
    // Should include text + vision tokens + overhead
    expect(cost).toBeGreaterThan(LFM3_VL_DEFAULT_VISION_TOKENS_PER_IMAGE)
  })

  it('plans context budget cleanly: preserves all messages when within context window', () => {
    const messages: AgentMessage[] = [
      { role: 'user', text: 'Xin chào' },
      { role: 'assistant', text: 'Chào bạn, tôi có thể giúp gì?' },
      { role: 'user', text: 'Hãy định dạng đoạn văn bản' },
    ]

    const plan = planContextBudget({
      system: 'Bạn là trợ lý soạn thảo GenOffice.',
      tools: [],
      messages,
      maxContextSize: 8192,
      maxOutputTokens: 1024,
    })

    expect(plan.fitsContext).toBe(true)
    expect(plan.prunedMessages.length).toBe(3)
    expect(plan.systemTokens).toBeGreaterThan(0)
    expect(plan.availableTokens).toBeGreaterThan(0)
  })

  it('plans context budget cleanly: trims oldest turns when overflowing while preserving system and latest turn', () => {
    // Generate many turns that exceed a small context window
    const messages: AgentMessage[] = []
    for (let i = 1; i <= 20; i++) {
      messages.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        text: `Đây là tin nhắn số ${i} với nội dung tương đối dài để kiểm tra việc cắt tỉa khi vượt quá giới hạn ngữ cảnh của mô hình.`,
      })
    }

    const plan = planContextBudget({
      system: 'CHỈ DẪN HỆ THỐNG RẤT QUAN TRỌNG: Tuyệt đối không xóa tài liệu.',
      tools: [],
      messages,
      maxContextSize: 500, // Very tight context
      maxOutputTokens: 128,
    })

    expect(plan.fitsContext).toBe(false)
    // System instructions must still have their budget
    expect(plan.systemTokens).toBeGreaterThan(0)
    // Must prune messages down to fit
    expect(plan.prunedMessages.length).toBeLessThan(messages.length)
    expect(plan.prunedMessages.length).toBeGreaterThanOrEqual(1)
    // The very latest message (index 20) MUST be preserved!
    const lastMsg = plan.prunedMessages[plan.prunedMessages.length - 1]
    expect(lastMsg && 'text' in lastMsg && lastMsg.text).toContain('số 20')
  })
})
