import { SYSTEM_DIRECTORY_NAMES } from '../folder-tree'
import { MIN_IMAGE_BYTES, mediaKindOfExtension, type MediaKind } from './media/media-kinds'

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  'node_modules',
  'build',
  'coverage',
  'dist',
  'venv',
])
export const SUPPORTED_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.tsv',
  '.ppt',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.txt',
])

export {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MIN_IMAGE_BYTES,
  mediaKindOfExtension,
  mediaKindOfPath,
  type MediaKind,
} from './media/media-kinds'

/** Documents (content-indexed) or media (name/metadata-indexed). */
export function isIndexableExtension(ext: string): boolean {
  const e = ext.toLowerCase()
  return SUPPORTED_EXTENSIONS.has(e) || mediaKindOfExtension(e) !== null
}

/** Per source folder; beyond it files are counted as `mediaSkipped` and the folder is flagged truncated. */
export const DEFAULT_MAX_MEDIA_PER_FOLDER = 200_000

/** Folders whose images are app resources, caches or thumbnails. Applies to MEDIA only (documents keep indexing there). */
const NOISE_MEDIA_DIRECTORIES = new Set([
  'thumbnails', 'thumbnail', 'thumbs', '@eadir', '__macosx', 'cache', 'caches', 'trash', '.trash', '.trashes',
  'node_modules', 'site-packages', 'assets', 'res', 'drawable', 'mipmap', 'icons', 'icon', 'sprites', 'sprite',
])
const NOISE_MEDIA_DIRECTORY_PATTERN = /(\.(photoslibrary|imovielibrary|xcassets|appiconset|imageset|app|framework|bundle)|^(drawable|mipmap)-[\w-]+)$/i

/** `dirs` are the folder names between the scanned root and the file (root itself is never judged). */
export function isNoiseMediaPath(dirs: readonly string[]): boolean {
  let previous = ''
  for (const dir of dirs) {
    const lower = dir.toLowerCase()
    if (NOISE_MEDIA_DIRECTORIES.has(lower) || NOISE_MEDIA_DIRECTORY_PATTERN.test(lower)) return true
    if (previous === 'library' && (lower === 'caches' || lower === 'cache')) return true
    previous = lower
  }
  return false
}

export type MediaRejection = 'noise-directory' | 'too-small'
/** Policy for one media file: `null` = admitted. `sizeBytes` is only judged when known. */
export function mediaRejection(
  kind: MediaKind,
  dirs: readonly string[],
  sizeBytes?: number,
): MediaRejection | null {
  if (isNoiseMediaPath(dirs)) return 'noise-directory'
  if (kind === 'image' && sizeBytes !== undefined && sizeBytes < MIN_IMAGE_BYTES) return 'too-small'
  return null
}

/** Editor/Office temp, backup and partial-download extensions: never a document, whatever is left of the name. */
const JUNK_EXTENSION = /\.(tmp|temp|swp|swo|bak|old|crdownload|download|partial|part|lock|lck)$/i
/** OS bookkeeping files (exact names, case-insensitive). Hidden `.DS_Store` / `._x` / `.~lock.x#` are caught by the dot rule. */
const JUNK_NAMES = new Set(['thumbs.db', 'ehthumbs.db', 'desktop.ini', 'icon\r'])

/**
 * A file name that is clutter, not a document: Word/Excel lock files (`~$x.docx`), editor temp (`*.tmp`,
 * `.~lock.x#`, `*.swp`), backups (`*.bak`, `*.old`, `x~`), partial downloads (`*.crdownload`, `*.part`,
 * `*.download`) and OS junk (`Thumbs.db`, `desktop.ini`, `.DS_Store`). Deliberately NOT matched: copies a person
 * made on purpose ("bản sao", "Copy of", "report (1).docx") - exact duplicates are the redundancy package's job.
 */
export function isJunkFileName(name: string): boolean {
  if (!name) return false
  return (
    name.startsWith('.') ||
    name.startsWith('~$') ||
    name.endsWith('~') ||
    JUNK_NAMES.has(name.toLowerCase()) ||
    JUNK_EXTENSION.test(name)
  )
}

/** Extension supported AND the name is not junk: the gate for paths arriving from watchers/intake without a directory walk. */
export function isIndexableFileName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return !isJunkFileName(name) && dot >= 0 && isIndexableExtension(name.slice(dot))
}

export function shouldSkipDirectory(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    name.startsWith('.') ||
    name.startsWith('$') ||
    IGNORED_DIRECTORIES.has(lower) ||
    SYSTEM_DIRECTORY_NAMES.has(lower)
  )
}
