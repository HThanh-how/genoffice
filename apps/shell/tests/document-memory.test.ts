import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

  it('keeps an old exact unique match above many weak recent vector matches', () => {
    const oldPath = join(directory, 'old-unique.txt')
    store.replaceDocument(oldPath, {
      hash: 'old-unique',
      mtimeMs: 1,
      sizeBytes: 30,
      chunks: [{ text: 'Moonstone 2-1 archive identifier', location: 'Chunk 1', vector: [1, 0] }],
      embeddingModel: 'test-v1',
      status: 'ready',
    })
    for (let i = 0; i < 40; i++) {
      const path = join(directory, `recent-${i}.txt`)
      replace(path, `recent generic notes ${i}`, [0.9, 0.1])
      store.remember(path)
    }
    const hits = store.search('Moonstone 2-1 archive', [1, 0], 5, 'test-v1')
    expect(hits[0]?.path).toBe(oldPath)
  })

  it('uses recency to settle otherwise tied results', () => {
    const oldPath = join(directory, 'older-tie.txt')
    const recentPath = join(directory, 'recent-tie.txt')
    const content = 'shared exact tie phrase'
    store.replaceDocument(oldPath, {
      hash: 'old-tie',
      mtimeMs: Date.now() - 365 * 24 * 60 * 60 * 1000,
      sizeBytes: content.length,
      chunks: [{ text: content, location: 'Chunk 1', vector: [1, 0] }],
      embeddingModel: 'test-v1',
      status: 'ready',
    })
    store.replaceDocument(recentPath, {
      hash: 'recent-tie',
      mtimeMs: Date.now(),
      sizeBytes: content.length,
      chunks: [{ text: content, location: 'Chunk 1', vector: [1, 0] }],
      embeddingModel: 'test-v1',
      status: 'ready',
    })
    store.remember(recentPath)
    expect(store.search('shared exact tie phrase', [1, 0], 2, 'test-v1')[0]?.path).toBe(recentPath)
  })

  it('widens a weak recent semantic scan and finds a strong older vector match', () => {
    const options = {
      semanticRecentScan: 1,
      semanticWideScan: 2,
      semanticFullScanThreshold: 2,
      semanticRelevanceThreshold: 1.1,
      semanticRecentDocuments: 1,
      semanticWideDocuments: 2,
    }
    store.close()
    store = new DocumentMemoryStore(dbPath, options)
    const oldPath = join(directory, 'deep-old-match.txt')
    store.replaceDocument(oldPath, {
      hash: 'deep-old',
      mtimeMs: 1,
      sizeBytes: 5,
      chunks: [{ text: 'archive concept', location: 'Chunk 1', vector: [0, 1] }],
      embeddingModel: 'test-v1',
      status: 'ready',
    })
    for (let i = 0; i < 10; i++) {
      const path = join(directory, `recent-text-only-${i}.txt`)
      store.replaceDocument(path, {
        hash: `text-only-${i}`,
        mtimeMs: Date.now() + i,
        sizeBytes: 5,
        chunks: [{ text: `recent text ${i}`, location: 'Chunk 1' }],
        embeddingModel: null,
        status: 'text-only',
      })
      store.remember(path)
    }
    for (let i = 0; i < 3; i++) {
      const path = join(directory, `weak-${i}.txt`)
      store.replaceDocument(path, {
        hash: `weak-${i}`,
        mtimeMs: Date.now() + i,
        sizeBytes: 5,
        chunks: [{ text: `ordinary ${i}`, location: 'Chunk 1', vector: [1, 0] }],
        embeddingModel: 'test-v1',
        status: 'ready',
      })
      store.remember(path)
    }
    expect(store.search('unmatched query', [0, 1], 4, 'test-v1')[0]?.path).toBe(oldPath)
  })

  it('adds priority columns without losing vectors from the previous schema', () => {
    const legacyPath = join(directory, 'legacy.sqlite')
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`CREATE TABLE documents (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL,
      mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT, error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
      text TEXT NOT NULL, normalized TEXT NOT NULL, location TEXT NOT NULL,
      vector BLOB, vector_dim INTEGER, UNIQUE(document_id, ordinal)
    );
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
    INSERT INTO documents(id,path,name,status,mtime_ms,size_bytes,hash,embedding_model)
      VALUES (1,'${join(directory, 'legacy.txt')}','legacy.txt','ready',1,12,'legacy-hash','test-v1');
    INSERT INTO chunks(id,document_id,ordinal,text,normalized,location,vector,vector_dim)
      VALUES (1,1,0,'legacy unique','legacy unique','Chunk 1',X'0000803F00000000',2);
    INSERT INTO chunk_fts(rowid,text) VALUES (1,'legacy unique');`)
    legacy.close()
    store.close()
    store = new DocumentMemoryStore(legacyPath)
    expect(store.stats()).toEqual({ docs: 1, chunks: 1, vectors: 1, errors: 0 })
    expect(store.search('legacy unique', [1, 0], 1, 'test-v1')[0]?.text).toBe('legacy unique')
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
