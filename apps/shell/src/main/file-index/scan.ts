import { readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { isHiddenEntry } from '../folder-tree'
import { SUPPORTED_EXTENSIONS, isJunkFileName, shouldSkipDirectory } from '../document-memory/scan-policy'

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

/** every supported, visible file under `root` with the stat fields the index keys on */
export function scanFiles(root: string): ScannedFile[] {
  return scanFileSnapshot(root).files
}

export function scanFileSnapshot(root: string): FileScanSnapshot {
  const out: ScannedFile[] = []
  let complete = true
  const walk = (dir: string) => {
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      complete = false
      return
    }
    for (const ent of dirents) {
      const path = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!shouldSkipDirectory(ent.name) && !isHiddenEntry(dir, ent.name, true)) walk(path)
      } else if (
        ent.isFile() &&
        isSupportedIndexFile(ent.name) &&
        !isHiddenEntry(dir, ent.name, false)
      ) {
        const st = statOrNull(path)
        if (st) out.push(st)
        else complete = false
      }
    }
  }
  walk(root)
  return { files: out, complete }
}

export function statOrNull(path: string): ScannedFile | null {
  try {
    const st = statSync(path)
    return st.isFile() ? { path, mtimeMs: st.mtimeMs, sizeBytes: st.size } : null
  } catch {
    return null
  }
}
