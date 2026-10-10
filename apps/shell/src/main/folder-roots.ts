import { accessSync, constants, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { FolderRoot } from '../shared/home-api'

/** app-settings.json key: folders the user added to the home tree beside the default save folder */
export const FOLDER_ROOTS_KEY = 'folderRoots'

/** app-settings.json key: list the default save folder ("GenOffice") in the Folders tree */
export const SHOW_DEFAULT_FOLDER_KEY = 'showDefaultFolder'

/** off until the person turns it on: the tree shows the folders they added, not the app's own */
export function showDefaultFolderFrom(settings: Record<string, unknown>): boolean {
  if (typeof settings[SHOW_DEFAULT_FOLDER_KEY] === 'boolean') {
    return settings[SHOW_DEFAULT_FOLDER_KEY]
  }
  return typeof settings['defaultSaveDir'] === 'string' && settings['defaultSaveDir'].length > 0
}

export function readExtraRoots(settings: Record<string, unknown>, defaultDir: string): string[] {
  const raw = settings[FOLDER_ROOTS_KEY]
  if (!Array.isArray(raw)) return []
  const seen = new Set([resolve(defaultDir)])
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isAbsolute(entry)) continue
    const key = resolve(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/** the list with `path` appended, or null when it already is a root */
export function withExtraRoot(
  extras: readonly string[],
  defaultDir: string,
  path: string,
): string[] | null {
  const key = resolve(path)
  if (key === resolve(defaultDir) || extras.some((e) => resolve(e) === key)) return null
  return [...extras, path]
}

export function withoutExtraRoot(extras: readonly string[], path: string): string[] {
  const key = resolve(path)
  return extras.filter((e) => resolve(e) !== key)
}

/** an added folder is shown as it is: never created, read-only ones list but refuse edits */
export function describeExtraRoot(path: string): FolderRoot {
  let readable = false
  let usable = false
  try {
    readable = statSync(path).isDirectory()
    if (readable) {
      accessSync(path, constants.R_OK)
      accessSync(path, constants.W_OK)
      usable = true
    }
  } catch {
    // a missing, unplugged or unwritable folder keeps whatever was established above
  }
  return { path, name: basename(path) || path, usable, readable, removable: true }
}
