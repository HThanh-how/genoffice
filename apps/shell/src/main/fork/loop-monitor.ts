import { monitorEventLoopDelay } from 'node:perf_hooks'

/** Log interval of the diagnostic, in milliseconds. */
const REPORT_INTERVAL_MS = 10_000

/**
 * Dev diagnostic for main-process jank, enabled by `GENOFFICE_DEBUG_LOOP=1`.
 *
 * Electron routes input and scrolling for every window through the main thread, so a stalled
 * main event loop makes all windows stutter. This samples the loop delay (1 ms resolution) and
 * prints the p50 / p99 / max delay every 10 s, then resets, so a periodic stall shows up as a
 * burst in `max`. Does nothing (and costs nothing) when the variable is unset.
 */
export function startLoopMonitor(
  log: (message: string) => void = (message) => console.log(message),
): (() => void) | null {
  if (process.env.GENOFFICE_DEBUG_LOOP !== '1') return null
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  const timer = setInterval(() => {
    const ms = (nanoseconds: number): string => (nanoseconds / 1e6).toFixed(1)
    log(
      `[loop-monitor] event-loop delay p50=${ms(histogram.percentile(50))} ms ` +
        `p99=${ms(histogram.percentile(99))} ms max=${ms(histogram.max)} ms ` +
        `(${histogram.count} samples / ${REPORT_INTERVAL_MS / 1000} s)`,
    )
    histogram.reset()
  }, REPORT_INTERVAL_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    histogram.disable()
  }
}
