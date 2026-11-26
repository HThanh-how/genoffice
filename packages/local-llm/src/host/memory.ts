import { execFileSync } from 'node:child_process'
import { freemem, totalmem } from 'node:os'

/**
 * Memory the model can really use. `os.freemem()` is the kernel's *free page* count on macOS:
 * file cache, inactive and purgeable pages are left out, so a Mac with 16 GiB and plenty of room
 * reports well under 1 GiB and the model was refused with "not enough RAM" on nearly every Mac.
 * Those pages are reclaimed on demand, so they count as available here.
 */
export function parseVmStat(output: string): number | undefined {
  const page = /page size of (\d+) bytes/.exec(output)?.[1]
  if (!page) return undefined
  const pages = (label: string): number =>
    Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(output)?.[1] ?? 0)
  const reclaimable = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')
  return reclaimable > 0 ? reclaimable * Number(page) : undefined
}

export function availableMemoryBytes(
  platform: string = process.platform,
  run: () => string = () => execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }),
  free: number = freemem(),
  total: number = totalmem(),
): number {
  if (platform !== 'darwin') return free
  try {
    const reclaimable = parseVmStat(run())
    if (reclaimable !== undefined) return Math.min(total, Math.max(free, reclaimable))
  } catch {
    // fall through to the estimate below
  }
  // vm_stat unavailable: a quarter of the RAM is a safe lower bound for a Mac that is not swapping
  return Math.max(free, total * 0.25)
}
