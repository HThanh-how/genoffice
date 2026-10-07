import { statSync } from 'node:fs'
import type { DocumentMemoryStore, DocumentMemoryHit } from '../store'
import { QueryEmbeddingCache } from '../query-embedding-cache'
import { fuseHybridResults } from '../hybrid-ranker'

export type FreshDocumentMemoryHit = DocumentMemoryHit & { stale?: boolean; missing?: boolean }

export interface SearchServiceOptions {
  store: DocumentMemoryStore
  externalNames?: (query: string, limit: number) => Promise<Array<{ path: string; name: string }>>
  askEmbed?: (text: string) => Promise<number[] | null>
  askSemantic?: (vector: number[], limit: number, spaceId: string) => Promise<Array<{ chunkId: number; rank: number; score: number; documentId: number }> | null>
  annotateFreshness?: (hits: DocumentMemoryHit[]) => Promise<FreshDocumentMemoryHit[]>
}

export class SearchService {
  private readonly offeredPaths = new Set<string>()
  private readonly queryCache = new QueryEmbeddingCache(64)
  private querySequence = 0

  constructor(private readonly options: SearchServiceOptions) {}

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  cancelActiveQuery(): void {
    this.querySequence++
  }

  async searchProgressive(
    query: string,
    limit = 8,
    callbacks?: {
      onLexical?: (hits: FreshDocumentMemoryHit[]) => void
      onFinal?: (hits: FreshDocumentMemoryHit[]) => void
    },
    activeEmbeddingModel?: string,
  ): Promise<FreshDocumentMemoryHit[]> {
    const queryId = ++this.querySequence

    // 1. Lexical and name matches
    const namedRaw = this.store.searchNames(query, 5)
    const seenNames = new Set(namedRaw.map((h) => h.documentId))
    const lexicalCandidates = this.store.searchLexical(query, 200)
    const lexicalRaw = this.store
      .hydrateChunkHits(lexicalCandidates.slice(0, limit))
      .filter((h) => !seenNames.has(h.documentId))
    const annotate = this.options.annotateFreshness ?? (async (hits) => hits.map((h) => ({ ...h, stale: false, missing: false })))
    const lexicalHits = await annotate([...namedRaw.slice(0, 3), ...lexicalRaw])

    if (this.querySequence !== queryId) return []
    callbacks?.onLexical?.(lexicalHits)

    // 2. Query embedding for semantic hybrid search
    let finalHits = lexicalHits
    if (this.options.askEmbed) {
      try {
        const spaceId = activeEmbeddingModel ?? 'default'
        let vector: number[] | null = this.queryCache.get(spaceId, query) ?? null
        if (!vector) {
          vector = await this.options.askEmbed(query)
          if (vector && vector.length) {
            this.queryCache.set(spaceId, query, vector)
          }
        }
        if (vector && vector.length) {
          let semanticCandidates: Array<{ chunkId: number; rank: number; score: number; documentId: number }> = []
          if (this.options.askSemantic) {
            const reply = await this.options.askSemantic(vector, 200, spaceId)
            if (reply) semanticCandidates = reply
          } else {
            semanticCandidates = this.store.searchSemantic(vector, 200, spaceId)
          }
          let finalChunkHits: DocumentMemoryHit[] = []
          if (semanticCandidates.length > 0) {
            const fused = fuseHybridResults(lexicalCandidates, semanticCandidates, { limit })
            finalChunkHits = this.store.hydrateChunkHits(fused)
          } else {
            finalChunkHits = lexicalRaw
          }
          const seen = new Set(finalChunkHits.map((h) => h.documentId))
          const namedForHybrid = namedRaw.filter((h) => !seen.has(h.documentId))
          finalHits = await annotate([...namedForHybrid.slice(0, 3), ...finalChunkHits])
          const stalePaths = new Set(lexicalHits.filter((h) => h.stale).map((h) => h.path))
          const missingPaths = new Set(lexicalHits.filter((h) => h.missing).map((h) => h.path))
          if (stalePaths.size > 0 || missingPaths.size > 0) {
            finalHits = finalHits.map((h) => ({
              ...h,
              stale: h.stale || stalePaths.has(h.path),
              missing: h.missing || missingPaths.has(h.path),
            }))
          }
        }
      } catch {
        // Fallback to lexical hits if embedding fails
      }
    }

    if (this.querySequence !== queryId) return []
    callbacks?.onFinal?.(finalHits)
    return finalHits
  }

  async searchExternal(
    query: string,
    limit: number,
    indexedPaths?: Set<string>,
  ): Promise<Array<{ path: string; name: string }>> {
    const files = (await this.options.externalNames?.(query, limit).catch(() => undefined)) ?? []
    const results: Array<{ path: string; name: string }> = []
    const seen = new Set<string>()
    for (const file of files) {
      const norm = process.platform === 'win32' ? file.path.toLowerCase() : file.path
      if (seen.has(norm)) continue
      if (indexedPaths?.has(norm)) continue
      seen.add(norm)
      results.push(file)
      this.offeredPaths.add(file.path)
      if (this.offeredPaths.size > 500) {
        this.offeredPaths.delete(this.offeredPaths.values().next().value!)
      }
    }
    return results
  }

  externalHit(file: { path: string; name: string }): DocumentMemoryHit {
    return {
      documentId: 0,
      path: file.path,
      name: file.name,
      chunkId: 0,
      text: 'The file name matches (found on disk, not in the index). Its content has not been read, so what it says is unknown. Open it by `path`.',
      location: 'file name',
      score: 0.5,
      hash: null,
      mtimeMs: null,
      sizeBytes: null,
      indexedAt: null,
      truncated: false,
      contentUnread: true,
    }
  }

  openOffered(path: string): string | null {
    if (!this.offeredPaths.has(path)) return null
    try {
      return statSync(path).isFile() ? path : null
    } catch {
      return null
    }
  }

  open(documentId: number): string | null {
    const document = this.store.documentById(documentId)
    if (!document || document.status === 'excluded') return null
    try {
      return statSync(document.path).isFile() ? document.path : null
    } catch {
      return null
    }
  }
}
