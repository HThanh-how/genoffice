import { cpSync, existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isInsidePath } from '../../shared/path-nesting'
import { moveOnDisk, uniqueNameIn } from '../folder-tree'

/** Files that are on the system clipboard (copied or cut in Explorer / Finder, or by this app). */
export interface ClipboardFiles {
  paths: string[]
  /** "Cut" in Explorer: the files move instead of being copied */
  cut: boolean
}

export interface PasteResult {
  pasted: number
  failed: number
  /** nothing to paste: the clipboard holds no files */
  none?: boolean
  error?: string
}

/** Explorer's "Preferred DropEffect": 2 is "move" (Cut), 1 and 5 are "copy". */
const DROP_EFFECT_MOVE = 2

/** Parse what the Windows clipboard reader prints: `EFFECT=<n>` then one path per line. */
export function parseClipboardFiles(output: string): ClipboardFiles {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const effect = lines[0]?.match(/^EFFECT=(\d+)$/)
  const paths = (effect ? lines.slice(1) : lines).filter((line) =>
    /^([A-Za-z]:[\\/]|\\\\|\/)/.test(line),
  )
  return { paths, cut: effect ? (Number(effect[1]) & DROP_EFFECT_MOVE) !== 0 : false }
}

/**
 * Put the clipboard's files into `targetDir`. Nothing is overwritten: a name already there gets
 * "(2)". A folder cannot go into itself, and cutting into the folder the files are already in
 * does nothing. Cut files move, the rest are copied; one failure does not stop the others.
 */
export function pasteFiles(targetDir: string, files: ClipboardFiles): PasteResult {
  const result: PasteResult = { pasted: 0, failed: 0 }
  if (files.paths.length === 0) return { ...result, none: true }
  for (const source of files.paths) {
    try {
      if (!existsSync(source)) throw new Error('missing')
      const isDir = statSync(source).isDirectory()
      if (isDir && (resolve(source) === resolve(targetDir) || isInsidePath(source, targetDir)))
        throw new Error('into itself')
      if (files.cut && resolve(dirname(source)) === resolve(targetDir)) continue
      const name = uniqueNameIn(targetDir, basename(source), isDir)
      const destination = join(targetDir, name)
      if (files.cut) moveOnDisk(source, destination)
      else cpSync(source, destination, { recursive: true, errorOnExist: true, force: false })
      result.pasted++
    } catch (error) {
      result.failed++
      result.error ??= error instanceof Error ? error.message : String(error)
    }
  }
  return result
}
