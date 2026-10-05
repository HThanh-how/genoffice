import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

describe('Embedding Space Isolation & Store V2', () => {
  let directory: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-space-'))
    const dbPath = join(directory, 'memory.sqlite')
    store = new DocumentMemoryStore(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps vector spaces isolated and never mixes embeddings from different models', () => {
    const doc1 = join(directory, 'f2-doc.txt')
    const doc2 = join(directory, 'qwen-doc.txt')

    // Document 1 with 320D vector (F2LLM)
    const vec320 = Array.from({ length: 320 }, (_, i) => (i === 0 ? 1 : 0))
    store.replaceDocument(doc1, {
      hash: 'h-f2',
      mtimeMs: 1000,
      sizeBytes: 50,
      chunks: [{ text: 'Machine learning for documents', location: 'Chunk 1', vector: vec320 }],
      embeddingModel: 'f2llm-v2-80m:v1',
      status: 'ready',
    })

    // Document 2 with 512D vector (Qwen)
    const vec512 = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0))
    store.replaceDocument(doc2, {
      hash: 'h-qwen',
      mtimeMs: 2000,
      sizeBytes: 50,
      chunks: [{ text: 'Deep learning natural language', location: 'Chunk 1', vector: vec512 }],
      embeddingModel: 'qwen3-embedding-0.6b:v1',
      status: 'ready',
    })

    // Search against F2LLM space (320D)
    const f2Hits = store.searchSemantic(vec320, 10, 'f2llm-v2-80m:v1')
    expect(f2Hits).toHaveLength(1)
    expect(f2Hits[0]?.documentId).toBe(1)

    // Search against Qwen space (512D)
    const qwenHits = store.searchSemantic(vec512, 10, 'qwen3-embedding-0.6b:v1')
    expect(qwenHits).toHaveLength(1)
    expect(qwenHits[0]?.documentId).toBe(2)

    // Search against non-existent space should yield zero semantic hits
    const emptyHits = store.searchSemantic(vec320, 10, 'unknown-model:v1')
    expect(emptyHits).toHaveLength(0)
  })

  it('records embedding spaces in metadata table', () => {
    const docPath = join(directory, 'test.txt')
    const vec = [0.6, 0.8]
    store.replaceDocument(docPath, {
      hash: 'h-meta',
      mtimeMs: 1000,
      sizeBytes: 20,
      chunks: [{ text: 'sample metadata check', location: 'Chunk 1', vector: vec }],
      embeddingModel: 'test-space-meta',
      status: 'ready',
    })

    const spaces = store.getEmbeddingSpaces()
    expect(spaces.some((s) => s.id === 'test-space-meta')).toBe(true)
  })

  it('updates semantic coverage calculation per active embedding space', () => {
    const docPath = join(directory, 'coverage.txt')
    const vec = [1, 0]
    store.replaceDocument(docPath, {
      hash: 'h-cov',
      mtimeMs: 1000,
      sizeBytes: 30,
      chunks: [{ text: 'coverage chunk', location: 'Chunk 1', vector: vec }],
      embeddingModel: 'f2llm-v2-80m:v1',
      status: 'ready',
    })

    const statsF2 = store.stats('f2llm-v2-80m:v1')
    expect(statsF2.activeEmbeddingSpace).toBe('f2llm-v2-80m:v1')
    expect(statsF2.semanticCoverage).toBe(1)

    const statsQwen = store.stats('qwen3-embedding-0.6b:v1')
    expect(statsQwen.semanticCoverage).toBe(0)
  })
})
