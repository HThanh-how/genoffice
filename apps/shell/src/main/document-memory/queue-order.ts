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
  /**
   * Near the storage quota: files modified/opened recently go right after the asked-for ones, ahead of the old
   * backlog and whatever their weight (a fresh file must not wait behind a year of untouched ones for room).
   */
  prioritize?: (path: string) => boolean
}

/** Where a file stands: 0 asked for now, 0.5 recent near the quota, 1-3 by weight, 4 pushed back. */
export function rankOf(path: string, info: QueueInfo, askPrioritize = true): number {
  if (info.urgent.has(path)) return 0
  if (info.deferred.has(path)) return 4
  if (askPrioritize && info.prioritize?.(path)) return 0.5
  return weightOf(info.bytes.get(path) ?? 0)
}

/**
 * `prioritize` is a database lookup per path, so it is only asked for the front of the line: the line is ordered
 * newest-opened first, and an order over 100k waiting files used to cost 100k queries on every pick and every status poll.
 */
export const PRIORITIZE_LOOKAHEAD = 256

/**
 * The reading order of the waiting line: what was asked for now, then light files, then medium,
 * then heavy, then what was pushed back; within each group the line's own order (newest opened
 * first) is kept. A single very large file therefore never holds up the many small ones.
 */
export function orderQueue(queue: readonly string[], info: QueueInfo): string[] {
  // ranks take a handful of values: one pass into buckets keeps the line's own order inside each, without an O(n log n) sort
  const buckets = new Map<number, string[]>()
  for (let index = 0; index < queue.length; index++) {
    const rank = rankOf(queue[index]!, info, index < PRIORITIZE_LOOKAHEAD)
    const bucket = buckets.get(rank)
    if (bucket) bucket.push(queue[index]!)
    else buckets.set(rank, [queue[index]!])
  }
  return [...buckets.keys()].sort((a, b) => a - b).flatMap((rank) => buckets.get(rank)!)
}

/**
 * The head of `orderQueue(queue, info)` without sorting or copying the line: one pass, the earliest of the best rank.
 * `skip` leaves a path out of the pick without removing it from the line (a file that cannot be taken yet): the pick is the
 * first of the best rank among the others, and undefined when nothing else is left.
 */
export function nextInOrder(
  queue: readonly string[],
  info: QueueInfo,
  skip?: (path: string) => boolean,
): string | undefined {
  let best: string | undefined
  let bestRank = Infinity
  for (let index = 0; index < queue.length; index++) {
    if (skip?.(queue[index]!)) continue
    const rank = rankOf(queue[index]!, info, index < PRIORITIZE_LOOKAHEAD)
    if (rank < bestRank) {
      best = queue[index]
      bestRank = rank
      if (rank === 0) break
    }
  }
  return best
}
