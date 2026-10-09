import { statSync } from 'node:fs'
import type { DocumentMemoryStore, DocumentMemoryHit } from '../store'
import { QueryEmbeddingCache } from '../query-embedding-cache'
import { fuseHybridResults } from '../hybrid-ranker'
import { embeddingProfile } from '../embedding-profiles'
import { capChunksPerDocument, promoteNameMatches } from './result-order'
import { annotateSkeletonHits, skeletonDocumentIds } from '../storage/repositories/skeleton-repository'

export type FreshDocumentMemoryHit = DocumentMemoryHit & {
  stale?: boolean
  missing?: boolean
  unverified?: boolean
  /** Only the outline of this document is kept (its repeated body was compacted); opening it re-reads the original. */
  skeletonIndex?: true
  skeletonNotice?: string
}

export interface SearchServiceOptions {
  store: DocumentMemoryStore
  externalNames?: (query: string, limit: number) => Promise<Array<{ path: string; name: string }>>
  askEmbed?: (text: string) => Promise<number[] | null>
  askSemantic?: (vector: number[], limit: number, spaceId: string) => Promise<Array<{ chunkId: number; rank: number; score: number; documentId: number }> | null>
  annotateFreshness?: (hits: DocumentMemoryHit[]) => Promise<FreshDocumentMemoryHit[]>
  /**
   * Opening a document whose body was compacted to a skeleton asks for the full re-read of the ORIGINAL file.
   * The manager wires its retry/read-now queue here; without it the document is only marked pending and the
   * periodic poll re-reads it (store.retryDocument is the same first step of both).
   */
  onSkeletonOpened?: (documentId: number) => void
}

function normalizeSearchPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export class SearchService {
  private readonly offeredPaths = new Set<string>()
  private readonly queryCache = new QueryEmbeddingCache(64)
  private querySequence = 0

  constructor(private readonly options: SearchServiceOptions) {}

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  get activeQueryToken(): number {
    return this.querySequence
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
      isCancelled?: () => boolean
    },
    activeEmbeddingModel?: string,
  ): Promise<FreshDocumentMemoryHit[]> {
    const queryToken = this.querySequence

    // 1. Lexical and name matches
    const namedRaw = this.store.searchNames(query, 5)
    const lexicalCandidates = this.store.searchLexical(query, 200)
    // Without semantic vectors the list is lexical only: at most 2 chunks per document, so one
    // long document cannot fill every slot while other matching documents are pushed out.
    const lexicalRaw = this.store.hydrateChunkHits(capChunksPerDocument(lexicalCandidates, limit))
    const annotateFresh = this.options.annotateFreshness ?? (async (hits) => hits.map((h) => ({ ...h, stale: false, missing: false })))
    // One extra indexed query per result list (never per hit); ranking and hit order are untouched.
    const annotate = async (hits: DocumentMemoryHit[]): Promise<FreshDocumentMemoryHit[]> => this.flagSkeletons(await annotateFresh(hits))
    let externalHits: DocumentMemoryHit[] = []
    if (this.options.externalNames) {
      const indexedPaths = new Set([...namedRaw, ...lexicalRaw].map((h) => normalizeSearchPath(h.path)))
      const externalFiles = await this.searchExternal(query, 5, indexedPaths)
      externalHits = externalFiles.slice(0, 3).map((f) => this.externalHit(f))
    }
    // Documents named like the query come first, even when their content also matches.
    const lexicalOrder = promoteNameMatches(namedRaw, lexicalRaw)
    const lexicalHits = await annotate([...lexicalOrder.head, ...externalHits, ...lexicalOrder.tail])

    if (callbacks?.isCancelled?.() || (queryToken !== undefined && this.querySequence !== queryToken)) return []
    callbacks?.onLexical?.(lexicalHits)

    // 2. Query embedding for semantic hybrid search
    let finalHits = lexicalHits
    if (this.options.askEmbed) {
      try {
        const spaceId = activeEmbeddingModel ?? (this.store.getEmbeddingSpaces?.()[0]?.id ?? 'default')
        let vector: number[] | null = this.queryCache.get(spaceId, query) ?? null
        if (!vector) {
          vector = await this.options.askEmbed(query)
          if (callbacks?.isCancelled?.() || (queryToken !== undefined && this.querySequence !== queryToken)) return []
          if (vector && vector.length) {
            this.queryCache.set(spaceId, query, vector)
          }
        }
        if (callbacks?.isCancelled?.() || (queryToken !== undefined && this.querySequence !== queryToken)) return []
        if (vector && vector.length) {
          let semanticCandidates: Array<{ chunkId: number; rank: number; score: number; documentId: number }> = []
          if (this.options.askSemantic) {
            const reply = await this.options.askSemantic(vector, 200, spaceId)
            if (callbacks?.isCancelled?.() || (queryToken !== undefined && this.querySequence !== queryToken)) return []
            if (reply) semanticCandidates = reply
          } else {
            semanticCandidates = this.store.searchSemantic(vector, 200, spaceId)
          }
          if (callbacks?.isCancelled?.() || (queryToken !== undefined && this.querySequence !== queryToken)) return []
          let finalChunkHits: DocumentMemoryHit[] = []
          if (semanticCandidates.length > 0) {
            const fused = fuseHybridResults(lexicalCandidates, semanticCandidates, {
              limit,
              query: { text: query, tier: embeddingProfile(spaceId).tier },
            })
            finalChunkHits = this.store.hydrateChunkHits(fused)
          } else {
            finalChunkHits = lexicalRaw
          }
          const hybridOrder = promoteNameMatches(namedRaw, finalChunkHits)
          finalHits = await annotate([...hybridOrder.head, ...externalHits, ...hybridOrder.tail])
          if (callbacks?.isCancelled?.() || (queryToken !== undefined && this.querySequence !== queryToken)) return []
          const stalePaths = new Set(lexicalHits.filter((h) => h.stale).map((h) => normalizeSearchPath(h.path)))
          const missingPaths = new Set(lexicalHits.filter((h) => h.missing).map((h) => normalizeSearchPath(h.path)))
          if (stalePaths.size > 0 || missingPaths.size > 0) {
            finalHits = finalHits.map((h) => {
              const norm = normalizeSearchPath(h.path)
              return {
                ...h,
                stale: h.stale || stalePaths.has(norm),
                missing: h.missing || missingPaths.has(norm),
              }
            })
          }
        }
      } catch {
        // Fallback to lexical hits if embedding fails
      }
    }

    if (callbacks?.isCancelled?.() || (queryToken !== undefined && this.querySequence !== queryToken)) return []
    callbacks?.onFinal?.(finalHits)
    return finalHits
  }

  /** Flags documents whose body was compacted to a skeleton; a store without the table or a closed db just returns the hits. */
  private flagSkeletons(hits: FreshDocumentMemoryHit[]): FreshDocumentMemoryHit[] {
    try {
      return annotateSkeletonHits(this.options.store.rawDb, hits)
    } catch {
      return hits
    }
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
      const norm = normalizeSearchPath(file.path)
      if (seen.has(norm)) continue
      if (
        indexedPaths?.has(norm) ||
        indexedPaths?.has(file.path) ||
        (process.platform === 'win32' && indexedPaths?.has(file.path.toLowerCase()))
      ) {
        continue
      }
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
      if (!statSync(document.path).isFile()) return null
    } catch {
      return null
    }
    this.rehydrateIfSkeleton(documentId)
    return document.path
  }

  /** The original is on disk (checked by the caller): a skeleton document gets its full text back, never the reverse. */
  private rehydrateIfSkeleton(documentId: number): void {
    try {
      if (skeletonDocumentIds(this.store.rawDb, [documentId]).size === 0) return
      if (this.options.onSkeletonOpened) this.options.onSkeletonOpened(documentId)
      else this.store.retryDocument(documentId)
    } catch {
      // opening the file must never fail because the index could not be refreshed
    }
  }
}
