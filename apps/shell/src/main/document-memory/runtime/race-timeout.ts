/**
 * Waits for `work`, but no longer than `ms`: after that the wait ends (the work itself goes on, nobody
 * waits for it). The timer is cleared as soon as the work settles, so it never keeps anything alive.
 */
export function raceTimeout(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  return Promise.race([work, limit]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
