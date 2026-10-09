import type { MediaKind } from './media-kinds'

export type { MediaKind }

/** What a bounded header read yields. Every field is optional: a damaged file still yields `{}`. */
export interface MediaMetadata {
  /** 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'tiff' | 'heic' | 'mp4' | 'mov' | '3gp' | 'mkv' | 'webm' | 'avi' | ... */
  container?: string
  width?: number
  height?: number
  durationMs?: number
  /** EXIF DateTimeOriginal / container creation time, epoch ms. */
  takenMs?: number
}

/** Random access to a file: `read` never throws and may return fewer bytes (or none) near EOF. */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Buffer>
}

/** `document_media.meta_state` */
export const MEDIA_META_PENDING = 0
export const MEDIA_META_READ = 1
export const MEDIA_META_UNREADABLE = 2

/** The media facts a search hit / the UI carries. */
export interface MediaHitInfo {
  kind: MediaKind
  container: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  takenMs: number | null
  /** Image that a later local light-OCR package may read (scans, ID cards, receipts, screenshots). */
  ocrCandidate: boolean
  /** Name/path suggests identity / legal / financial papers: never leaves the device. */
  sensitive: boolean
}
