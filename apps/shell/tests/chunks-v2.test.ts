import { describe, expect, it } from 'vitest'
import {
  CHUNKER_VERSION,
  chunkDocumentText,
  chunkDocumentTextV1,
  chunkDocumentTextV2,
} from '../src/main/document-memory/chunks'

describe('Chunker V2 Architecture & Backward Compatibility', () => {
  it('exposes CHUNKER_VERSION = 2', () => {
    expect(CHUNKER_VERSION).toBe(2)
  })

  it('keeps backward compatibility with chunkDocumentText alias', () => {
    const text = 'Short paragraph for backward compatibility testing.'
    const chunksV1 = chunkDocumentTextV1(text)
    const chunksAlias = chunkDocumentText(text)
    expect(chunksAlias).toEqual(chunksV1)
    expect(chunksAlias[0]?.location).toBe('Chunk 1')
  })

  it('chunks documents with target ~1200 chars and respects paragraph boundaries', () => {
    // 3 paragraphs of 300 chars each: Total ~900 chars (< 1200 target chars)
    const p1 = 'Paragraph 1 '.repeat(25).trim() // ~300 chars
    const p2 = 'Paragraph 2 '.repeat(25).trim() // ~300 chars
    const p3 = 'Paragraph 3 '.repeat(25).trim() // ~300 chars
    const input = `${p1}\n\n${p2}\n\n${p3}`

    const chunks = chunkDocumentTextV2(input)
    // Under V2 (target 1200), all 3 fit within a single chunk of ~900 chars
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toContain('Paragraph 1')
    expect(chunks[0]?.text).toContain('Paragraph 3')
  })

  it('splits long content at sentence boundaries without exceeding max chars', () => {
    // Generate a long text of multiple distinct sentences
    const sentence = 'This is a long sentence about GenOffice document search architecture. '
    const longText = sentence.repeat(50) // ~3500 chars

    const chunks = chunkDocumentTextV2(longText)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1800)
      // Check that it ends cleanly (e.g. with a period or complete token)
      expect(chunk.text.trim().endsWith('.')).toBe(true)
    }
  })

  it('preserves section context when provided', () => {
    const text = 'Sample content with header information.'
    const chunks = chunkDocumentTextV2(text, {
      title: 'Annual Report',
      sectionPath: ['Finance', 'Q4'],
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.metadata?.sectionPath).toEqual(['Finance', 'Q4'])
  })
})
