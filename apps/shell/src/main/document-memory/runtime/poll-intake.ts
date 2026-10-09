import { createYielder } from '../yield-budget'

/** Above this many waiting files a poll does not look for more: everything incomplete is already in (or on its way into) the line. */
export const POLL_BACKLOG_LIMIT = 2_000

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
