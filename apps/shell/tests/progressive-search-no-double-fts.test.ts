import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'

const mockVector320 = () => new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1)

class FakeSearchWorker extends EventEmitter {
  sentMessages: Array<{ id: number; type: string; vector?: number[] | null }> = []

  constructor(private readonly dbPath: string) {
    super()
  }

  postMessage(message: {
    id: number
    type: string
    vector?: number[] | null
    limit?: number
    embeddingSpaceId?: string
    texts?: string[]
  }) {
    this.sentMessages.push(message)
    setTimeout(() => {
      if (message.type === 'embed') {
        this.emit('message', {
          id: message.id,
          result: (message.texts ?? []).map(() => mockVector320()),
        })
      } else if (message.type === 'search-semantic') {
        const store = new DocumentMemoryStore(this.dbPath, { role: 'worker' })
        const result = store.searchSemantic(
          message.vector ?? mockVector320(),
          message.limit ?? 200,
          message.embeddingSpaceId ?? EMBEDDING_PROFILES.standard.embeddingId,
        )
        store.close()
        this.emit('message', { id: message.id, result })
      } else {
        this.emit('message', { id: message.id, result: [] })
      }
    }, 5)
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('Progressive Search: No Double Lexical FTS Query', () => {
  let dir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'no-double-fts-test-'))
    managers = []
  })

  afterEach(() => {
    for (const m of managers) m.close()
    resetIndexingPolicyBus()
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs lexical search exactly once per user query and fuses semantic via main thread', async () => {
    let fakeWorker: FakeSearchWorker | null = null
    const mgr = new DocumentMemoryManager(dir, {
      pollIntervalMs: 60_000,
      workerFactory: (_path, data) => {
        fakeWorker = new FakeSearchWorker(data.dbPath)
        return fakeWorker as never
      },
    })
    managers.push(mgr)

    // Seed test documents
    mgr.store.replaceDocument(join(dir, 'annual_report_2026.docx'), {
      hash: 'h1',
      mtimeMs: 1000,
      sizeBytes: 200,
      chunks: [
        { text: 'Financial summary and revenue for annual report', location: 'Page 1', vector: mockVector320() },
      ],
      status: 'ready',
      embeddingModel: EMBEDDING_PROFILES.standard.embeddingId,
    })

    // Instrument search methods on main store
    const searchLexicalSpy = vi.spyOn(mgr.store, 'searchLexical')
    const searchNamesSpy = vi.spyOn(mgr.store, 'searchNames')
    const searchLegacySpy = vi.spyOn(mgr.store, 'search')
    const hydrateChunkHitsSpy = vi.spyOn(mgr.store, 'hydrateChunkHits')

    let lexicalFired = false
    let finalFired = false

    await mgr.searchProgressive('annual report', 5, {
      onLexical: (hits) => {
        lexicalFired = true
        expect(hits.length).toBeGreaterThanOrEqual(1)
      },
      onFinal: (hits) => {
        finalFired = true
        expect(hits.length).toBeGreaterThanOrEqual(1)
      },
    })

    // Assert lexical was queried exactly ONCE
    expect(searchLexicalSpy).toHaveBeenCalledTimes(1)

    // Assert filename search was called exactly ONCE
    expect(searchNamesSpy).toHaveBeenCalledTimes(1)

    // Assert legacy double-search method was NOT called
    expect(searchLegacySpy).not.toHaveBeenCalled()

    // Assert single query batch chunk hydration was used
    expect(hydrateChunkHitsSpy).toHaveBeenCalled()

    // Worker was queried for semantic search only, never for lexical search
    expect(fakeWorker).not.toBeNull()
    const workerTypes = fakeWorker!.sentMessages.map((m) => m.type)
    expect(workerTypes).not.toContain('search') // Legacy full search must not be sent
    expect(workerTypes).toContain('search-semantic') // Only semantic candidates requested

    expect(lexicalFired).toBe(true)
    expect(finalFired).toBe(true)
  })
})
