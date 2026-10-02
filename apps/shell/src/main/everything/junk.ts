import { extname } from 'node:path'
import { isIgnoredFileName, shouldSkipDirectory } from '../document-memory/folder-scan'

/** Files that are machinery, not something a person looks for. */
const JUNK_EXTENSIONS = new Set([
  '.dll',
  '.sys',
  '.drv',
  '.ocx',
  '.obj',
  '.pdb',
  '.lib',
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.so',
  '.dylib',
  '.mui',
  '.cat',
  '.etl',
  '.log',
])

/** Folders that hold the system, installed programs or caches (lower case). */
const JUNK_DIRECTORIES = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  '$recycle.bin',
  'system volume information',
  'site-packages',
  '__pycache__',
  'winsxs',
])

/** Files that run when opened: never offered to, or opened for, the assistant. */
const PROGRAM_EXTENSIONS = new Set([
  '.exe',
  '.com',
  '.scr',
  '.msi',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.hta',
  '.lnk',
  '.reg',
  '.jar',
  '.cpl',
])

export function isProgramFile(path: string): boolean {
  return PROGRAM_EXTENSIONS.has(extname(path).toLowerCase())
}

/** True for a path nobody searches for: system files, installed programs, caches, build output. */
export function isJunkPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  const name = parts.pop()
  if (!name || isIgnoredFileName(name)) return true
  if (JUNK_EXTENSIONS.has(extname(name).toLowerCase())) return true
  // the first part of a Windows path is the drive ("C:"), never junk by itself
  return parts.some(
    (part, index) =>
      (index > 0 || !/^[a-z]:$/i.test(part)) &&
      (shouldSkipDirectory(part) || JUNK_DIRECTORIES.has(part.toLowerCase())),
  )
}
