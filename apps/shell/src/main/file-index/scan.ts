import { readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { isHiddenEntry } from '../folder-tree'
import {
  SUPPORTED_EXTENSIONS,
  isJunkFileName,
  shouldSkipDirectory,
} from '../document-memory/scan-policy'

/** Name and content indexes admit the same document formats. */
export function isSupportedIndexFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase()) && !isJunkFileName(basename(name))
}

export interface ScannedFile {
  path: string
  mtimeMs: number
  sizeBytes: number
}
export interface FileScanSnapshot {
  files: ScannedFile[]
  /** Only a complete walk can establish that an unseen file was actually removed. */
  complete: boolean
}

export interface ScanResult {
  files: ScannedFile[]
  /** the walk hit a budget, so `files` is not the full set under the root */
  truncated: boolean
}

export const SCAN_MAX_DEPTH = 32
export const SCAN_MAX_FILES = 200_000

interface ScanLimits {
  maxDepth?: number
  maxFiles?: number
}

/**
 * Every supported, visible file under `root` with the stat fields the index keys
 * on. Symlinked directories are not followed (a Dirent reports them as
 * symlinks, not directories), and the walk is bounded by depth and file count.
 * `unreadable` is set when a directory or file could not be read, `truncated`
 * when a budget stopped the walk; either way the file list is not the full set.
 */
function walkSupportedFiles(
  root: string,
  limits: ScanLimits,
): { files: ScannedFile[]; truncated: boolean; unreadable: boolean } {
  const maxDepth = limits.maxDepth ?? SCAN_MAX_DEPTH
  const maxFiles = limits.maxFiles ?? SCAN_MAX_FILES
  const out: ScannedFile[] = []
  let truncated = false
  let unreadable = false
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) {
      truncated = true
      return
    }
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      unreadable = true
      return
    }
    for (const ent of dirents) {
      if (out.length >= maxFiles) {
        truncated = true
        return
      }
      const path = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!shouldSkipDirectory(ent.name) && !isHiddenEntry(dir, ent.name, true))
          walk(path, depth + 1)
      } else if (
        ent.isFile() &&
        isSupportedIndexFile(ent.name) &&
        !isHiddenEntry(dir, ent.name, false)
      ) {
        const st = statOrNull(path)
        if (st) out.push(st)
        else unreadable = true
      }
    }
  }
  walk(root, 0)
  return { files: out, truncated, unreadable }
}

export function scanFiles(root: string, limits: ScanLimits = {}): ScanResult {
  const { files, truncated } = walkSupportedFiles(root, limits)
  return { files, truncated }
}

/** Like scanFiles, but `complete` is false for a budget stop or any unreadable entry. */
export function scanFileSnapshot(root: string, limits: ScanLimits = {}): FileScanSnapshot {
  const { files, truncated, unreadable } = walkSupportedFiles(root, limits)
  return { files, complete: !truncated && !unreadable }
}

export function statOrNull(path: string): ScannedFile | null {
  try {
    const st = statSync(path)
    return st.isFile() ? { path, mtimeMs: st.mtimeMs, sizeBytes: st.size } : null
  } catch {
    return null
  }
}
