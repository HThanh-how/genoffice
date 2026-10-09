import type { DocumentMemoryHit } from '../store'

interface ChunkCandidate {
  chunkId: number
  documentId: number
}

/**
 * The first `limit` lexical candidates with at most `maxPerDocument` chunks per document, so a
 * document with many matching chunks cannot crowd every other document out of the list. A
 * document's best chunks (the earliest in candidate order) are the ones kept. When fewer than
 * `limit` remain, the skipped chunks backfill in their original order.
 */
export function capChunksPerDocument<T extends ChunkCandidate>(
  candidates: readonly T[],
  limit: number,
  maxPerDocument = 2,
): T[] {
  const perDocument = new Map<number, number>()
  const selected: T[] = []
  const skipped: T[] = []
  for (const candidate of candidates) {
    const count = perDocument.get(candidate.documentId) ?? 0
    if (count >= maxPerDocument) {
      skipped.push(candidate)
      continue
    }
    perDocument.set(candidate.documentId, count + 1)
    selected.push(candidate)
    if (selected.length >= limit) return selected
  }
  return [...selected, ...skipped.slice(0, limit - selected.length)]
}

/**
 * Puts documents whose file name matches the query ahead of content-only hits. A named document
 * that also has a content hit is represented by that content hit (it carries the snippet) rather
 * than being dropped behind other documents; name-only documents keep their name hit. At most
 * `maxNameOnly` documents that were not already found by content are added, as before.
 */
export function promoteNameMatches(
  named: readonly DocumentMemoryHit[],
  chunkHits: readonly DocumentMemoryHit[],
  maxNameOnly = 3,
): { head: DocumentMemoryHit[]; tail: DocumentMemoryHit[] } {
  const firstChunkOfDocument = new Map<number, DocumentMemoryHit>()
  for (const hit of chunkHits) if (!firstChunkOfDocument.has(hit.documentId)) firstChunkOfDocument.set(hit.documentId, hit)
  const head: DocumentMemoryHit[] = []
  const promoted = new Set<DocumentMemoryHit>()
  let nameOnly = 0
  for (const hit of named) {
    const chunk = firstChunkOfDocument.get(hit.documentId)
    if (chunk) {
      head.push(chunk)
      promoted.add(chunk)
    } else if (nameOnly < maxNameOnly) {
      head.push(hit)
      nameOnly++
    }
  }
  return { head, tail: chunkHits.filter((hit) => !promoted.has(hit)) }
}
