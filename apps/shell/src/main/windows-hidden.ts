import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

/**
 * Names in a folder that Windows itself hides: the entries with the Hidden or System attribute
 * ($RECYCLE.BIN, System Volume Information, pagefile.sys and whatever the person or a program
 * hid). Node cannot read file attributes, so the answer comes from `attrib`, once per folder
 * listing and remembered for a few seconds. Anywhere but Windows nothing is hidden this way.
 */

const CACHE_MS = 15_000
const TIMEOUT_MS = 4_000

export type AttribRunner = (command: string) => Promise<string>

/**
 * Parse `attrib /d <dir>\*`: one line per entry, the attribute letters first (A, S, H, R, I...), then the
 * full path. Returns the lower-cased names of the entries that are Hidden or System.
 */
export function parseHiddenNames(output: string): Set<string> {
  const names = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const start = line.search(/[A-Za-z]:\\/)
    if (start < 0) continue
    // what stands before the path is only attribute letters
    if (!/[SH]/.test(line.slice(0, start))) continue
    const name = win32.basename(line.slice(start))
    if (name) names.add(name.toLocaleLowerCase())
  }
  return names
}

const runAttrib: AttribRunner = (command) =>
  new Promise((resolve) => {
    // code page 65001 makes attrib print UTF-8, so Vietnamese names come back intact
    execFile(
      'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: TIMEOUT_MS,
        maxBuffer: 32 << 20,
        encoding: 'utf8',
      },
      (_error, stdout) => resolve(typeof stdout === 'string' ? stdout : ''),
    )
  })

const cache = new Map<string, { at: number; names: Set<string> }>()

/** The names Windows hides in `dir`; empty when not on Windows, when it cannot tell, or on any doubt. */
export async function hiddenNamesIn(
  dir: string,
  options: { platform?: NodeJS.Platform; run?: AttribRunner; now?: () => number } = {},
): Promise<Set<string>> {
  const platform = options.platform ?? process.platform
  // a quote or a percent sign in the path would be read by cmd.exe as syntax: no attributes then
  if (platform !== 'win32' || /["%]/.test(dir) || !/^[A-Za-z]:\\/.test(dir)) return new Set()
  const now = (options.now ?? Date.now)()
  const key = dir.toLocaleLowerCase()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.names
  const folder = dir.endsWith('\\') ? dir : `${dir}\\`
  const output = await (options.run ?? runAttrib)(`"chcp 65001>nul & attrib /d "${folder}*""`)
  const names = parseHiddenNames(output)
  cache.set(key, { at: now, names })
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  return names
}

/** Test seam. */
export function resetHiddenNamesCache(): void {
  cache.clear()
}
