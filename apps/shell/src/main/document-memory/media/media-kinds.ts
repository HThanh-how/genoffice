/** Pure media kind tables (no imports: shared by the scan policy, the name projection and the media modules). */

/** Images: indexed by name + header metadata only (never decoded). `.svg` is deliberately absent (vector UI assets). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.jfif', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif',
])
/** Videos: indexed by name + container metadata only (no audio, subtitles or frames, ever). No audio-only formats. */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp',
])
export type MediaKind = 'image' | 'video'

export function mediaKindOfExtension(ext: string): MediaKind | null {
  const e = ext.toLowerCase()
  return IMAGE_EXTENSIONS.has(e) ? 'image' : VIDEO_EXTENSIONS.has(e) ? 'video' : null
}
export function mediaKindOfPath(path: string): MediaKind | null {
  const dot = path.lastIndexOf('.')
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return dot > sep + 1 ? mediaKindOfExtension(path.slice(dot)) : null
}
/** Images below this are icons / sprites / tracking pixels, not photos or scans. */
export const MIN_IMAGE_BYTES = 16 * 1024
/** Images above this are never read by OCR (the local pass skips them; extraction does not look for OCR text). */
export const MAX_OCR_IMAGE_BYTES = 25 * 1024 * 1024
