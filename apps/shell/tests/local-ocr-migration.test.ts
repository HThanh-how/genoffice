import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { IMAGE_OCR_STATE, markImageOcr, selectImageOcrCandidates } from '../src/main/document-memory/media/media-ocr-gate'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

const profile = EMBEDDING_PROFILES.standard

let directory: string
let dbPath: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'genoffice-local-ocr-migration-'))
  dbPath = join(directory, 'document-memory.db')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('storage migration keeps the local-OCR tier, the failure ledger and the media OCR state', () => {
  it('copies engine / quality / tier / escalate, ocr_local_failures and document_media', () => {
    const pdf = join(directory, 'scan.pdf')
    const image = join(directory, 'photo.png')
    const todo = join(directory, 'todo.png')
    copyFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'), image)
    copyFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'), todo)

    const source = new DocumentMemoryStore(dbPath)
    source.ensureEmbeddingSpace(profile)
    // a scanned PDF that gained OCR text, opened by the user so retention keeps it
    source.replaceDocument(pdf, {
      hash: 'pdf-hash', mtimeMs: 1000, sizeBytes: 5000,
      chunks: [{ text: 'Công ty Viettel hóa đơn 0433', location: 'OCR page 1', vector: new Array(profile.dimensions).fill(0.1) }],
      embeddingModel: profile.embeddingId, status: 'ready',
    })
    source.rawDb.prepare('UPDATE documents SET last_opened_at = unixepoch() WHERE path = ?').run(pdf)
    const meta = { hash: 'pdf-hash', mtimeMs: 1000, sizeBytes: 5000, totalPages: 3 }
    source.ocr.savePages(pdf, { ...meta, tier: 'local', engine: 'tesseract-vie', quality: 0.91, escalate: false, model: 'local:tesseract-vie' }, [{ page: 1, text: 'good local page' }])
    source.ocr.savePages(pdf, { ...meta, tier: 'local', engine: 'tesseract-vie', quality: 0.31, escalate: true, model: 'local:tesseract-vie' }, [{ page: 2, text: 'bad local page' }])
    source.ocr.savePages(pdf, { ...meta, model: 'gemini' }, [{ page: 3, text: 'cloud page' }])
    source.ocr.recordLocalFailure(pdf, { mtimeMs: 1000, sizeBytes: 5000 }, 'render-timeout')
    // two images: one already read locally, one still waiting
    for (const path of [image, todo]) {
      const st = statSync(path)
      expect(source.enrollMedia(path, st.mtimeMs, st.size).outcome).toBe('created')
    }
    const imageId = source.documentByPath(image)!.id
    markImageOcr(source.rawDb, imageId, IMAGE_OCR_STATE.done)
    source.rawDb.prepare('UPDATE document_media SET width = 1240, height = 700, sensitive = 1 WHERE document_id = ?').run(imageId)
    source.close()

    const result = migrateStorageV2ToV3(dbPath, { activeSpaceId: profile.embeddingId, activeDimensions: profile.dimensions })
    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)

    const migrated = new DocumentMemoryStore(dbPath)
    try {
      // the tier columns survive: a local row is still local, an escalated one still waits for the cloud
      expect(migrated.ocr.pageTier(pdf, 1)).toEqual({ tier: 'local', engine: 'tesseract-vie', quality: 0.91, escalate: false })
      expect(migrated.ocr.pageTier(pdf, 2)).toEqual({ tier: 'local', engine: 'tesseract-vie', quality: 0.31, escalate: true })
      expect(migrated.ocr.pageTier(pdf, 3)).toMatchObject({ tier: 'cloud', escalate: false })
      expect(migrated.ocr.pagesDone(pdf, 1000, 5000)).toEqual([1, 3])
      expect(migrated.ocr.escalatedPages(pdf, 1000, 5000)).toEqual([2])
      // the failure ledger survives (a broken file is not retried at every start)
      expect(migrated.ocr.localFailure(pdf)).toMatchObject({ attempts: 1, code: 'render-timeout' })
      // media rows keep their header facts, sensitive marker and OCR state
      const row = migrated.rawDb
        .prepare('SELECT kind, width, height, sensitive, ocr_candidate, ocr_state FROM document_media WHERE document_id = ?')
        .get(imageId)
      expect(row).toEqual({ kind: 'image', width: 1240, height: 700, sensitive: 1, ocr_candidate: 1, ocr_state: IMAGE_OCR_STATE.done })
      // only the image that was never read is still local OCR work
      expect(selectImageOcrCandidates(migrated.rawDb, { engine: 'local' }).map((c) => c.path)).toEqual([todo])
    } finally {
      migrated.close()
    }
  })
})
