/** Up to this size a file is read in a moment (a text document, a small PDF). */
export const LIGHT_BYTES = 5 * 1024 * 1024
/** From this size a file ties up the reader for minutes (a scanned decree, a huge sheet). */
export const HEAVY_BYTES = 25 * 1024 * 1024

/** 1 light, 2 medium, 3 heavy: how long a file of this size is likely to hold the reader. */
export function weightOf(bytes: number): 1 | 2 | 3 {
  return bytes < LIGHT_BYTES ? 1 : bytes < HEAVY_BYTES ? 2 : 3
}

export interface QueueInfo {
  /** files a person asked to have read now, ahead of everything */
  urgent: ReadonlySet<string>
  /** files a person (or the app) pushed to the back, behind everything */
  deferred: ReadonlySet<string>
  /** size of each waiting file; an unknown one counts as light */
  bytes: ReadonlyMap<string, number>
}

/** Where a file stands: 0 asked for now, 1-3 by weight, 4 pushed back. */
export function rankOf(path: string, info: QueueInfo): number {
  if (info.urgent.has(path)) return 0
  if (info.deferred.has(path)) return 4
  return weightOf(info.bytes.get(path) ?? 0)
}

/**
 * The reading order of the waiting line: what was asked for now, then light files, then medium,
 * then heavy, then what was pushed back; within each group the line's own order (newest opened
 * first) is kept. A single very large file therefore never holds up the many small ones.
 */
export function orderQueue(queue: readonly string[], info: QueueInfo): string[] {
  return queue
    .map((path, index) => ({ path, index, rank: rankOf(path, info) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.path)
}
