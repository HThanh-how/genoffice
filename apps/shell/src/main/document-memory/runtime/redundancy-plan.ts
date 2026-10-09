import {
  exactLineKey,
  hasDistinctiveToken,
  isHeadingLike,
  isMarkerLine,
  splitLines,
} from './redundancy-text'

export interface RedundancyParams {
  /** A line is template text when it occurs in at least this many DISTINCT sibling documents. */
  k: number
  /** Families with fewer distinct documents than this never derive new boilerplate from siblings. */
  minFamilyDocs: number
  /** Documents below this boilerplate ratio (share of template characters) are not compaction candidates. */
  minDocRatio: number
  /** Skeleton size budget per document (characters), raised to 20% of the text for text-heavy documents. */
  skeletonByteCap: number
  /** Do not bother with a document that would free less than this many characters. */
  minReclaimChars: number
  /** T-A drops the vector of a chunk when at least this share of its characters is template text. */
  vectorChunkShare: number
  /** Family model is built from at most this many distinct sibling documents. */
  maxSampleDocs: number
  /** At most this many characters of one document are read for analysis. */
  maxDocChars: number
}

export const REDUNDANCY_DEFAULTS: Readonly<RedundancyParams> = Object.freeze({
  k: 3,
  minFamilyDocs: 3,
  minDocRatio: 0.5,
  skeletonByteCap: 3072,
  minReclaimChars: 1024,
  vectorChunkShare: 0.5,
  maxSampleDocs: 40,
  maxDocChars: 200_000,
})

export interface FamilyModel {
  familyKey: string
  /** Line fingerprints (digits kept) that are template text for this family. */
  boiler: ReadonlySet<number>
  /** Line fingerprint -> number of sample documents containing it. */
  exactFreq: ReadonlyMap<number, number>
  sampleDocs: number
}

export function emptyFamilyModel(familyKey: string): FamilyModel {
  return { familyKey, boiler: new Set(), exactFreq: new Map(), sampleDocs: 0 }
}

/**
 * Per-sample-document line counters; call once per DISTINCT sibling document.
 *
 * Lines are identified WITH their digits ("Số lượng: 12" and "Số lượng: 15" are different lines): template text
 * is what repeats verbatim, and a line whose digits change is data a person may search for, so it is never
 * declared boilerplate just because the words around the number repeat.
 */
export class FamilyLineCounter {
  readonly exact = new Map<number, number>()
  docs = 0

  addDocument(lines: Iterable<string>): void {
    this.docs++
    const seen = new Set<number>()
    for (const line of lines) {
      const ex = exactLineKey(line)
      if (ex !== null && !seen.has(ex)) {
        seen.add(ex)
        this.exact.set(ex, (this.exact.get(ex) ?? 0) + 1)
      }
    }
  }

  /** Template keys derived from the sample (empty when the sample is too small to prove anything). */
  derivedBoilerplate(params: RedundancyParams): number[] {
    if (this.docs < params.minFamilyDocs) return []
    const out: number[] = []
    for (const [key, count] of this.exact) if (count >= params.k) out.push(key)
    return out
  }
}

export interface PlanChunkInput {
  id: number
  ordinal: number
  text: string
  /** The whole chunk is a known repeated chunk (boilerplate_fingerprints). */
  globalBoiler: boolean
}

export type ChunkActionKind = 'keep' | 'rewrite' | 'drop'

export interface ChunkAction {
  chunkId: number
  ordinal: number
  action: ChunkActionKind
  newText?: string
  oldChars: number
  newChars: number
  /** Share of this chunk's characters that skeleton selection removes (0..1). */
  droppedShare: number
}

export interface DocumentPlan {
  chunks: ChunkAction[]
  totalChars: number
  keptChars: number
  droppedChars: number
  /** Share of characters that are template text (what document_redundancy.boilerplate_ratio stores). */
  boilerplateRatio: number
  /** Chunks that stay unchanged / are rewritten / are removed. */
  counts: { keep: number; rewrite: number; drop: number }
}

interface LineEntry {
  chunk: number
  order: number
  text: string
  chars: number
  priority: number
  boiler: boolean
}

const DROPPABLE = 9
const TITLE_LINES = 3

/**
 * Skeleton selection (C). Pure.
 *
 * Priority of a line (lower = kept first):
 *   0  one of the first lines of the document (the title)
 *   1  locator line: Tuần/Bài/Tiết/Chủ đề/Môn/Lớp/Chương/Điều... (SKELETON_MARKER_TERMS)
 *   2  carries an id / amount / date / e-mail that is NOT repeated across siblings
 *   3  unique line: not template text for the family (the real lesson content)
 *   4  heading-like line even if it is template text (keeps the structure, only while the cap allows)
 *   9  everything else: template text -> dropped
 * Exact copies (`duplicate`) keep only priorities 0, 1 and 4: all their content exists in the preferred copy.
 */
export function planSkeleton(
  chunks: PlanChunkInput[],
  model: FamilyModel,
  params: RedundancyParams = REDUNDANCY_DEFAULTS,
  options: { duplicate?: boolean } = {},
): DocumentPlan {
  const duplicate = options.duplicate === true
  const entries: LineEntry[] = []
  const byChunk: LineEntry[][] = []
  let docLine = 0
  let totalChars = 0
  let boilerChars = 0
  chunks.forEach((chunk, ci) => {
    const lines = splitLines(chunk.text)
    const mineEntries: LineEntry[] = []
    byChunk.push(mineEntries)
    lines.forEach((text) => {
      const ex = exactLineKey(text)
      // a repeated chunk (chunk_fingerprints ignore digits) only makes its digit-free lines template text
      const boiler = ex !== null && (model.boiler.has(ex) || (chunk.globalBoiler && !/\d/.test(text)))
      const marker = isMarkerLine(text)
      let priority = DROPPABLE
      if (docLine < TITLE_LINES) priority = 0
      else if (marker) priority = 1
      else if (duplicate) priority = isHeadingLike(text) ? 4 : DROPPABLE
      else {
        if (hasDistinctiveToken(text) && (ex === null || (model.exactFreq.get(ex) ?? 0) < params.k)) priority = 2
        else if (!boiler) priority = 3
        else if (isHeadingLike(text)) priority = 4
      }
      docLine++
      const chars = text.length
      totalChars += chars
      if (boiler && priority >= 4) boilerChars += chars
      const entry = { chunk: ci, order: entries.length, text, chars, priority, boiler }
      entries.push(entry)
      mineEntries.push(entry)
    })
  })

  const cap = duplicate
    ? Math.floor(params.skeletonByteCap / 2)
    : Math.max(params.skeletonByteCap, Math.ceil(totalChars * 0.2))
  const keep = new Set<number>()
  const seenText = new Set<string>()
  let used = 0
  for (const entry of [...entries].sort((a, b) => a.priority - b.priority || a.order - b.order)) {
    if (entry.priority === DROPPABLE) break
    if (entry.priority > 0) {
      // a line repeated inside one document is stored once
      if (seenText.has(entry.text)) continue
      if (used + entry.chars + 1 > cap) continue
    }
    seenText.add(entry.text)
    keep.add(entry.order)
    used += entry.chars + 1
  }

  const counts = { keep: 0, rewrite: 0, drop: 0 }
  const actions: ChunkAction[] = chunks.map((chunk, ci) => {
    const mine = byChunk[ci]!
    let kept = mine.filter((e) => keep.has(e.order))
    // a chunk that would only keep template headings carries no information of its own: remove it
    if (ci > 0 && kept.length > 0 && kept.every((e) => e.priority === 4)) kept = []
    const oldChars = mine.reduce((sum, e) => sum + e.chars, 0)
    const newChars = kept.reduce((sum, e) => sum + e.chars, 0)
    let action: ChunkActionKind
    if (mine.length === 0 || kept.length === mine.length) action = 'keep'
    else if (kept.length === 0) action = 'drop'
    else action = 'rewrite'
    return {
      chunkId: chunk.id,
      ordinal: chunk.ordinal,
      action,
      ...(action === 'rewrite' ? { newText: kept.map((e) => e.text).join('\n') } : {}),
      oldChars,
      newChars,
      droppedShare: oldChars > 0 ? (oldChars - newChars) / oldChars : 0,
    }
  })
  // Never remove every chunk of a document: identity must keep at least one searchable chunk.
  if (actions.length > 0 && actions.every((a) => a.action === 'drop')) {
    const first = actions[0]!
    first.action = 'keep'
    first.newChars = first.oldChars
    first.droppedShare = 0
    delete first.newText
  }
  if (actions.length < 2) {
    for (const a of actions) {
      a.action = 'keep'
      a.droppedShare = 0
      delete a.newText
    }
  }
  for (const a of actions) counts[a.action]++
  const finalKept = actions.reduce((sum, a) => sum + (a.action === 'keep' ? a.oldChars : a.newChars), 0)
  return {
    chunks: actions,
    totalChars,
    keptChars: finalKept,
    droppedChars: Math.max(0, totalChars - finalKept),
    boilerplateRatio: totalChars > 0 ? boilerChars / totalChars : 0,
    counts,
  }
}
