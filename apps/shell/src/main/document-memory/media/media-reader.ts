import { extname } from 'node:path'
import { withFileSource } from './byte-source'
import { readImageMetadata } from './image-headers'
import { readVideoMetadata } from './video-headers'
import type { MediaKind, MediaMetadata } from './media-types'

/** One name per format, whatever the extension spelling. */
const CONTAINER_ALIASES: Record<string, string> = {
  jpg: 'jpeg', jfif: 'jpeg', tif: 'tiff', heif: 'heic', mpeg: 'mpg', m4v: 'm4v',
}

/**
 * Bounded, read-only metadata of one media file: first 64 KB plus a few small positioned reads, never
 * the whole file, never pixels / audio / subtitles. `null` = the file could not be opened or read
 * in time (the caller keeps the row, marks it unreadable and does not retry until mtime/size change).
 * Never throws and never hangs longer than `timeoutMs`.
 */
export async function readMediaMetadata(
  path: string,
  kind: MediaKind,
  timeoutMs?: number,
): Promise<MediaMetadata | null> {
  const ext = extname(path).slice(1).toLowerCase()
  const found = await withFileSource(
    path,
    (source) => (kind === 'image' ? readImageMetadata(source) : readVideoMetadata(source, ext)),
    timeoutMs,
  )
  if (!found) return null
  const container = found.container ?? (CONTAINER_ALIASES[ext] ?? (ext || undefined))
  return { ...found, container }
}
