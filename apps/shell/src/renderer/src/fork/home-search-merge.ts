import type { FileSearchHit, RecentEntry } from '../../../shared/home-api'
import { nameWordsKeepingFillers } from '../../../main/document-memory/normalization'
import { nameScore } from './file-name-search'

/** a full-coverage, typo-free name/folder match scores at least this much in {@link nameScore} */
const INSTANT_MIN_SCORE = 110
export const INSTANT_LIMIT = 30

/**
 * The typed words, accents/case folded. Filler words stay: the box is filtering names, not parsing a question, and
 * "giao an" must not shrink to "giao" because "an" is a filler word elsewhere.
 */
export function instantWords(query: string): string[] {
  return nameWordsKeepingFillers(query)
}

/**
 * Files already loaded in the Home lists (recents, starred, opened folders) whose name or folder holds every typed
 * word - accents and case ignored, the last word may be a prefix. Synchronous: it runs before any IPC call so a file
 * in plain sight shows up on the first keystroke. Best match first; ties keep the order of `files`.
 */
export function instantNameMatches(
  files: Iterable<RecentEntry>,
  query: string,
  accept: (entry: RecentEntry) => boolean = () => true,
  limit = INSTANT_LIMIT,
): FileSearchHit[] {
  const words = instantWords(query)
  if (words.length === 0) return []
  const best = new Map<string, { entry: RecentEntry; score: number }>()
  for (const entry of files) {
    if (entry.missing || best.has(entry.path) || !accept(entry)) continue
    const score = nameScore(entry.name, entry.path, words, words.length)
    if (score >= INSTANT_MIN_SCORE) best.set(entry.path, { entry, score })
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => ({ ...entry, snippet: null, needles: words }))
}

/**
 * The "file names" group: instant matches keep their place at the top, the engine's name-only hits follow in the
 * engine's order. A path both have keeps the instant row's position but takes the engine's data (starred flag,
 * needles), so rows already on screen never move when the engine answers.
 */
export function mergeNameGroup(
  instant: readonly FileSearchHit[],
  engine: readonly FileSearchHit[],
): FileSearchHit[] {
  const fromEngine = new Map(engine.map((h) => [h.path, h]))
  const out: FileSearchHit[] = instant.map((h) => fromEngine.get(h.path) ?? h)
  const seen = new Set(out.map((h) => h.path))
  for (const h of engine) {
    if (seen.has(h.path)) continue
    seen.add(h.path)
    out.push(h)
  }
  return out
}

/** the "content" group: the full-search hits (already in their final order) without the files shown above */
export function contentGroup(
  content: readonly FileSearchHit[],
  names: readonly FileSearchHit[],
): FileSearchHit[] {
  const shown = new Set(names.map((h) => h.path))
  return content.filter((h) => !shown.has(h.path))
}

/**
 * Result count over both groups. The full search also matches names, so its total already counts the name hits;
 * only when its page is complete can a name row missing from it (an instant-only match) be added on top.
 */
export function searchTotal(
  names: readonly FileSearchHit[],
  content: { hits: readonly FileSearchHit[]; total: number } | null,
): number {
  if (!content) return names.length
  if (content.hits.length < content.total) return content.total
  const inContent = new Set(content.hits.map((h) => h.path))
  return content.total + names.filter((h) => !inContent.has(h.path)).length
}
