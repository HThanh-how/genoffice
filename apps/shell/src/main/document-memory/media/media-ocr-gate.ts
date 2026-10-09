import type { DatabaseSync } from 'node:sqlite'

/** `document_media.ocr_state`: owned by the OCR package; 0 = never attempted. */
export const IMAGE_OCR_STATE = { none: 0, done: 1, skipped: 2, failed: 3 } as const

export interface ImageOcrCandidate {
  documentId: number
  path: string
  sizeBytes: number
  mtimeMs: number
  width: number | null
  height: number | null
  sensitive: boolean
}

export interface ImageOcrSelection {
  /** 'local' = an on-device engine; 'cloud' = anything that sends the picture off the device (Antigravity ...). */
  engine: 'local' | 'cloud'
  /** The user explicitly allowed images to be read by a cloud engine. Required for engine 'cloud'. */
  cloudOptIn?: boolean
  limit?: number
}

/**
 * THE gate for reading text out of images.
 *  - local engine: every image candidate, sensitive ones included (they never leave the device);
 *  - cloud engine: nothing at all unless the user opted in, and even then never a sensitive image.
 * The scanned-PDF cloud reader (`OcrSidecar.candidates`) does not call this: it only sees PDFs.
 *
 * Used by the local light-OCR pass (local-ocr/local-ocr-job.ts): select here with engine 'local', write the
 * recognised text to `ocr_pages` (keyed by path + file hash, tier 'local'), then
 * `markImageOcr(db, id, IMAGE_OCR_STATE.done)`. A changed file resets `ocr_state` to 0 automatically
 * (media re-enrollment).
 */
export function selectImageOcrCandidates(db: DatabaseSync, selection: ImageOcrSelection): ImageOcrCandidate[] {
  if (selection.engine === 'cloud' && selection.cloudOptIn !== true) return []
  const rows = db
    .prepare(
      `SELECT d.id AS documentId, d.path AS path, coalesce(d.size_bytes, 0) AS sizeBytes,
              coalesce(d.mtime_ms, 0) AS mtimeMs, m.width AS width, m.height AS height, m.sensitive AS sensitive
       FROM document_media m JOIN documents d ON d.id = m.document_id
       WHERE m.kind = 'image' AND m.ocr_candidate = 1 AND m.ocr_state = ${IMAGE_OCR_STATE.none}
         AND d.excluded = 0 ${selection.engine === 'cloud' ? 'AND m.sensitive = 0' : ''}
       ORDER BY m.document_id LIMIT ?`,
    )
    .all(Math.max(1, Math.min(selection.limit ?? 50, 500))) as unknown as Array<Omit<ImageOcrCandidate, 'sensitive'> & { sensitive: number }>
  return rows.map((row) => ({ ...row, sensitive: row.sensitive === 1 }))
}

export function markImageOcr(db: DatabaseSync, documentId: number, state: number): void {
  db.prepare('UPDATE document_media SET ocr_state = ? WHERE document_id = ?').run(state, documentId)
}
