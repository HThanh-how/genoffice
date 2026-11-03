import { statSync } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { RecentEntry, RecentPage, RecentQuery } from '../shared/home-api'
import { rootAvailability } from './document-memory/root-availability'

const RECENT_PAGE_DEFAULT = 50
const RECENT_PAGE_MAX = 200

function toRecentEntry(path: string, starredPaths: ReadonlySet<string>): RecentEntry {
  try {
    const stat = statSync(path)
    return {
      path,
      name: basename(path),
      ext: extname(path).slice(1).toLowerCase(),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      starred: starredPaths.has(path),
    }
  } catch {
    // A failed stat is often transient (disconnected drive, pending mount,
    // cloud placeholder) — dropping the entry made the recents list silently
    // lose files until a later reload (r158). Word keeps unavailable recents
    // listed; the row is flagged so the UI can dim it and offer removal.
    return {
      path,
      name: basename(path),
      ext: extname(path).slice(1).toLowerCase(),
      mtimeMs: 0,
      sizeBytes: 0,
      starred: starredPaths.has(path),
      missing: true,
    }
  }
}

export function statPathEntries(
  paths: readonly string[],
  starredPaths: ReadonlySet<string>,
): RecentEntry[] {
  return paths.map((path) => toRecentEntry(path, starredPaths))
}

/** A dead network share can hold a single stat for ~24s; never let one row hold a list that long. */
export const STAT_ENTRY_TIMEOUT_MS = 2000
// libuv's default threadpool has 4 threads and a stat stuck on a dead share holds one until the OS
// gives up, so keep well below it and stop statting a root as soon as it looks unreachable
const STAT_CONCURRENCY = 3

function missingEntry(
  path: string,
  starredPaths: ReadonlySet<string>,
  unavailable = false,
): RecentEntry {
  return {
    path,
    name: basename(path),
    ext: extname(path).slice(1).toLowerCase(),
    mtimeMs: 0,
    sizeBytes: 0,
    starred: starredPaths.has(path),
    missing: true,
    ...(unavailable ? { unavailable: true } : {}),
  }
}

/**
 * Async twin of toRecentEntry for IPC handlers on the main process: a stat that fails or does
 * not answer within `timeoutMs` yields the same `missing` row as a failed stat, so the list
 * returns promptly and the row is retried on the next load.
 */
async function toRecentEntryAsync(
  path: string,
  starredPaths: ReadonlySet<string>,
  timeoutMs: number,
  statImpl: (path: string) => Promise<{ mtimeMs: number; size: number }>,
  suspectRoots: Set<string>,
): Promise<RecentEntry> {
  // offline or not-yet-verified root: no stat at all, so no threadpool thread is spent on it
  const root = rootAvailability.rootOf(path)
  if (suspectRoots.has(root) || rootAvailability.shouldDeferSyncIo(path))
    return missingEntry(path, starredPaths, true)
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  try {
    const stat = await Promise.race([
      statImpl(path),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error('stat timeout'))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
    return {
      path,
      name: basename(path),
      ext: extname(path).slice(1).toLowerCase(),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      starred: starredPaths.has(path),
    }
  } catch {
    if (timedOut) {
      // the hung stat still holds a threadpool thread: stop statting this root for this batch
      suspectRoots.add(root)
      // a stat that does not answer is a reachability problem, not a missing file: probe the root
      // once (shared verdict) so the next rows and the next load skip it
      void rootAvailability.checkPath(path, true)
      return missingEntry(path, starredPaths, true)
    }
    return missingEntry(path, starredPaths)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function statPathEntriesAsync(
  paths: readonly string[],
  starredPaths: ReadonlySet<string>,
  options: {
    timeoutMs?: number
    statImpl?: (path: string) => Promise<{ mtimeMs: number; size: number }>
  } = {},
): Promise<RecentEntry[]> {
  const timeoutMs = options.timeoutMs ?? STAT_ENTRY_TIMEOUT_MS
  const statImpl = options.statImpl ?? ((p: string) => fsStat(p))
  const entries: RecentEntry[] = new Array(paths.length)
  let next = 0
  const suspectRoots = new Set<string>()
  // bounded concurrency: the timeouts overlap instead of adding up row by row
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next++
      entries[index] = await toRecentEntryAsync(
        paths[index]!,
        starredPaths,
        timeoutMs,
        statImpl,
        suspectRoots,
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, worker))
  return entries
}

export const STAT_PATHS_MAX = RECENT_PAGE_MAX

/** stat is synchronous; a renderer-supplied list is bounded like every recents page */
export function capStatPaths(paths: readonly string[]): string[] {
  return paths.slice(0, STAT_PATHS_MAX)
}

export function normalizeRecentQuery(
  raw: unknown,
): Required<Omit<RecentQuery, 'ext' | 'group' | 'excludeIgnored'>> & { ext?: string } {
  const query = (raw ?? {}) as RecentQuery
  // offset/limit cross the preload boundary, so an IPC caller may send "10" rather
  // than 10; without coercion every page silently restarted at the first page.
  const rawOffset = Number(query.offset)
  const rawLimit = Number(query.limit)
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  const limit = Number.isFinite(rawLimit)
    ? Math.min(RECENT_PAGE_MAX, Math.max(0, Math.floor(rawLimit)))
    : RECENT_PAGE_DEFAULT
  // Sidebar keys are bare extensions ("xlsx"), but IPC callers may send
  // ".xlsx", " XLSX ", or "..." — normalize so openable files cannot hide
  // behind a filter that only differs in dots/case/whitespace.
  const rawExt =
    typeof query.ext === 'string' ? query.ext.trim().toLowerCase().replace(/^\.+/, '') : ''
  const ext = rawExt ? rawExt : undefined
  return { offset, limit, ext }
}

/** sidebar filter keys that stand for a family of extensions, not one exact ext */
export const EXT_FAMILY: Record<string, readonly string[]> = {
  // mirrors Home's FILTER_FAMILY and SEARCH_EXT_FAMILY
  docx: ['docx', 'doc', 'dot', 'odt', 'ott', 'hwpx', 'hwp'],
  // delimited text belongs to the sheets family: Home's own FILTER_FAMILY and
  // the shell's open routing both treat .csv/.tsv as spreadsheets, so a
  // sidebar filtered on "xlsx" must page them in too (csv was missing here).
  xlsx: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'],
  pptx: ['pptx', 'ppt', 'odp', 'otp'],
  // the text app opens txt/json as source too, so the sidebar "md" filter has
  // to page them in the same way Home's FILTER_FAMILY already does — otherwise
  // the two views disagree about which files the filter means.
  md: ['md', 'markdown', 'txt', 'json'],
  html: ['html', 'htm'],
}

/** Family-aware extension match for sidebar filters (recents and starred share it). */
export function matchesExtFamily(entryExt: string, filterExt: string): boolean {
  const family = EXT_FAMILY[filterExt]
  return family ? family.includes(entryExt) : entryExt === filterExt
}

/** Async, time-bounded version of pageRecentPaths for the IPC handler. */
export async function pageRecentPathsAsync(
  paths: readonly string[],
  raw: unknown,
  starredPaths: ReadonlySet<string>,
  options?: Parameters<typeof statPathEntriesAsync>[2],
): Promise<RecentPage> {
  const { offset, limit, ext } = normalizeRecentQuery(raw)
  const filtered = ext
    ? paths.filter((p) => matchesExtFamily(extname(p).slice(1).toLowerCase(), ext))
    : paths
  const page = limit === 0 ? [] : filtered.slice(offset, offset + limit)
  return {
    entries: await statPathEntriesAsync(page, starredPaths, options),
    total: filtered.length,
    totalAll: paths.length,
  }
}

/** Page over the recents paths, preserving the source's newest-first order (unavailable paths stay, flagged missing). */
export function pageRecentPaths(
  paths: readonly string[],
  raw: unknown,
  starredPaths: ReadonlySet<string>,
): RecentPage {
  const { offset, limit, ext } = normalizeRecentQuery(raw)
  // stat only the returned page: statting the whole list blocked main on long recents
  const filtered = ext
    ? paths.filter((p) => matchesExtFamily(extname(p).slice(1).toLowerCase(), ext))
    : paths
  const page = limit === 0 ? [] : filtered.slice(offset, offset + limit)
  return {
    entries: statPathEntries(page, starredPaths),
    total: filtered.length,
    totalAll: paths.length,
  }
}
