import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { chunkDocumentText } from '../src/main/document-memory/chunks'

let directory: string
let store: DocumentMemoryStore
let dbPath: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'genoffice-memory-'))
  dbPath = join(directory, 'memory.sqlite')
  store = new DocumentMemoryStore(dbPath)
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const replace = (
  path: string,
  text: string,
  vector?: number[],
  embeddingModel: string | null = vector ? 'test-v1' : null,
) =>
  store.replaceDocument(path, {
    hash: `hash-${text.length}`,
    mtimeMs: 10,
    sizeBytes: text.length,
    chunks: [{ text, location: 'Chunk 1', ...(vector ? { vector } : {}) }],
    embeddingModel,
    status: vector ? 'ready' : 'text-only',
  })

describe('DocumentMemoryStore', () => {
  it('searches content with accent and class code normalization, while generic words do not dominate', () => {
    const path = join(directory, 'lesson.docx')
    replace(path, 'Lớp 2-1 học phép cộng: 7 + 5 = 12.')
    expect(store.search('tim file lop2 1', null)).toHaveLength(1)
    expect(store.search('class2/1', null)).toHaveLength(1)
    expect(store.search('tim file co', null)).toHaveLength(0)
    expect(store.search('12', null)).toHaveLength(1)
  })

  it('uses cosine ranking and lexical/vector reciprocal rank fusion', () => {
    replace(join(directory, 'low.txt'), 'shared subject low', [0.8, 0.6])
    replace(join(directory, 'high.txt'), 'different words', [1, 0])
    expect(store.search('find', [1, 0], 2, 'test-v1')[0]?.name).toBe('high.txt')
    expect(store.search('find', [1, 0], 2, 'test-v1')[1]?.name).toBe('low.txt')
    expect(store.search('find', [1, 0], 2, 'other-model')).toHaveLength(0)
  })

  it('persists opened documents and replaces stale chunks and vectors', () => {
    const path = join(directory, 'persistent.txt')
    replace(path, 'old unique content', [1, 0])
    const firstId = store.search('old', null)[0]!.chunkId
    store.close()
    store = new DocumentMemoryStore(dbPath)
    expect(store.documentByPath(path)?.status).toBe('ready')
    replace(path, 'new content', [0, 1])
    expect(store.readChunk(firstId)).toBeNull()
    expect(store.search('old', null)).toHaveLength(0)
    expect(store.stats()).toEqual({ docs: 1, chunks: 1, vectors: 1, errors: 0 })
  })

  it('excludes content, moves metadata, clears, and keeps transactions intact on a conflicting move', () => {
    const a = join(directory, 'a.txt'),
      b = join(directory, 'b.txt')
    replace(a, 'alpha secret')
    replace(b, 'beta')
    expect(() => store.move(a, b)).toThrow()
    expect(store.documentByPath(a)).not.toBeNull()
    store.move(a, join(directory, 'renamed.txt'))
    expect(store.search('alpha', null)[0]?.name).toBe('renamed.txt')
    store.exclude(join(directory, 'renamed.txt'))
    store.clear()
    store.remember(join(directory, 'renamed.txt'))
    expect(store.documentByPath(join(directory, 'renamed.txt'))?.status).toBe('excluded')
    expect(store.search('alpha', null)).toHaveLength(0)
    expect(store.stats().chunks).toBe(0)
    store.clear()
    expect(store.listDocuments().map((doc) => doc.status)).toEqual(['excluded'])
  })

  it('escapes FTS operators and rejects invalid vectors', () => {
    replace(join(directory, 'query.txt'), 'ordinary text')
    expect(() => store.search('" OR * ( NEAR', null)).not.toThrow()
    expect(() => replace(join(directory, 'bad.txt'), 'bad vector', [Number.NaN, 0])).toThrow(
      /finite/,
    )
  })

  it('chunks tables and long paragraphs without losing their trailing content', () => {
    const body = `Heading\n\n| Item | Value |\n| A | 15 |\n\n${'word '.repeat(500)}ENDMARKER`
    const chunks = chunkDocumentText(body)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)?.text).toContain('ENDMARKER')
    expect(chunks.every((chunk) => chunk.text.length <= 1000)).toBe(true)
    expect(chunks[0]?.text).toContain('| A | 15 |')
  })
})

it('adds vector batches without changing chunk ids or losing prior vectors', () => {
  const path = join(directory, 'batched.txt')
  store.replaceDocument(path, {
    hash: 'batch-hash',
    mtimeMs: 10,
    sizeBytes: 20,
    chunks: [1, 2, 3].map((n) => ({ text: `chunk ${n}`, location: `Chunk ${n}` })),
    embeddingModel: null,
    status: 'text-only',
  })
  const ids = store.search('chunk', null, 3).map((hit) => hit.chunkId)
  store.setChunkVectors(path, 'batch-hash', 0, [[1, 0]], 'test-v1', false)
  store.setChunkVectors(
    path,
    'batch-hash',
    1,
    [
      [0, 1],
      [-1, 0],
    ],
    'test-v1',
    true,
  )
  expect(store.stats().vectors).toBe(3)
  expect(store.search('unmatched', [1, 0], 3, 'test-v1').map((hit) => hit.chunkId)).toEqual([
    ids[0],
    ids[1],
    ids[2],
  ])
})
