import { statSync } from 'node:fs'
import type { DocumentMemoryStore, DocumentMemoryHit } from '../store'

export type FreshDocumentMemoryHit = DocumentMemoryHit & { stale?: boolean; missing?: boolean }

export interface SearchServiceOptions {
  store: DocumentMemoryStore
  externalNames?: (query: string, limit: number) => Promise<Array<{ path: string; name: string }>>
  askEmbed?: (text: string) => Promise<number[] | null>
  annotateFreshness?: (hits: DocumentMemoryHit[]) => Promise<FreshDocumentMemoryHit[]>
}

export class SearchService {
  private readonly offeredPaths = new Set<string>()

  constructor(private readonly options: SearchServiceOptions) {}

  get store(): DocumentMemoryStore {
    return this.options.store
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
    // 1. Lexical hits first
    const lexicalRaw = this.store.search(query, null, limit, activeEmbeddingModel)
    const annotate = this.options.annotateFreshness ?? (async (hits) => hits.map((h) => ({ ...h, stale: false, missing: false })))
    const lexicalHits = await annotate(lexicalRaw)
    callbacks?.onLexical?.(lexicalHits)

    // 2. Query embedding for semantic hybrid search
    let finalHits = lexicalHits
    if (this.options.askEmbed) {
      try {
        const vector = await this.options.askEmbed(query)
        if (vector && vector.length) {
          const hybridRaw = this.store.search(query, vector, limit, activeEmbeddingModel)
          finalHits = await annotate(hybridRaw)
        }
      } catch {
        // Fallback to lexical hits if embedding fails
      }
    }

    callbacks?.onFinal?.(finalHits)
    return finalHits
  }

  async searchExternal(
    query: string,
    limit: number,
  ): Promise<Array<{ path: string; name: string }>> {
    const files = (await this.options.externalNames?.(query, limit).catch(() => undefined)) ?? []
    for (const file of files) {
      this.offeredPaths.add(file.path)
      if (this.offeredPaths.size > 500) {
        this.offeredPaths.delete(this.offeredPaths.values().next().value!)
      }
    }
    return files
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
