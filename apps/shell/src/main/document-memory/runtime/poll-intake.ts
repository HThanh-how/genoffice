import { createYielder } from '../yield-budget'

/** Rows read per database page of a poll: a page is a key range, so it costs about this many index entries. */
export const POLL_PAGE_SIZE = 512

export interface IncompleteRow {
  path: string
  priorityAt: number
  id: number
}

/**
 * Hands the incomplete paths of a poll to `enqueue` in slices of at most a few milliseconds. Each `enqueue` is a database
 * lookup, so 150k pending documents used to be one loop of seconds that held Electron's main thread (and every window
 * with it) in a single piece.
 */
export async function enqueueIncompleteSliced(
  paths: readonly string[],
  isBusy: (path: string) => boolean,
  enqueue: (path: string) => void,
  isStopped: () => boolean,
): Promise<void> {
  const maybeYield = createYielder()
  for (const path of paths) {
    if (isStopped()) return
    if (!isBusy(path)) enqueue(path)
    await maybeYield()
  }
}

/**
 * The poll's whole intake: the waiting line is read page by page (`readPage(after)`, ordered, resumed after the last row of
 * the previous page) and every path is handed over in the same few-millisecond slices. A backlog of any size is read in
 * full - a poll must never decide that "enough is already waiting" and add nothing, because a path that fell out of the
 * in-memory line (a refusal, a restart of the worker, a file that changed) is only brought back by the next poll.
 * Returns how many paths were seen.
 */
export async function enqueueIncompletePaged(options: {
  readPage: (after: { priorityAt: number; id: number } | null, limit: number) => IncompleteRow[]
  isBusy: (path: string) => boolean
  enqueue: (path: string) => void
  isStopped: () => boolean
  pageSize?: number
}): Promise<number> {
  const maybeYield = createYielder()
  const pageSize = options.pageSize ?? POLL_PAGE_SIZE
  let after: { priorityAt: number; id: number } | null = null
  let seen = 0
  for (;;) {
    if (options.isStopped()) return seen
    const page = options.readPage(after, pageSize)
    for (const row of page) {
      if (options.isStopped()) return seen
      seen++
      if (!options.isBusy(row.path)) options.enqueue(row.path)
      await maybeYield()
    }
    if (page.length < pageSize) return seen
    const last = page[page.length - 1]!
    after = { priorityAt: last.priorityAt, id: last.id }
    await maybeYield()
  }
}
