import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { SearchService } from '../src/main/document-memory/runtime/search-service'
import { SKELETON_NOTICE } from '../src/main/document-memory/storage/repositories/skeleton-repository'
import { ensureRedundancySchema } from '../src/main/document-memory/storage/redundancy-schema'
import { hitsToSources, buildRetrievalContext } from '../src/renderer/src/home-chat/agy-retrieval'

/**
 * A document whose repeated body was compacted to a skeleton must be flagged in search results (so the UI can say
 * "outline only - open to read in full"), without any change of ranking, and opening it must re-hydrate through the
 * existing retry / read-now path (store.retryDocument -> re-extraction -> new active chunk set -> skeleton row gone).
 */
let dir: string
let store: DocumentMemoryStore
let service: SearchService

function seed(name: string, text: string): number {
  const path = join(dir, name)
  writeFileSync(path, text) // the original exists on disk
  store.replaceDocument(path, { hash: `h-${name}`, mtimeMs: 1000, sizeBytes: 500, chunks: [{ text, location: 'Page 1' }], status: 'ready' })
  return store.documentByPath(path)!.id
}

function markSkeleton(documentId: number): void {
  ensureRedundancySchema(store.rawDb)
  store.rawDb
    .prepare("INSERT OR REPLACE INTO document_skeleton (document_id, stage, hash, family_key, kept_chunks, dropped_chunks, dropped_bytes, compacted_at) VALUES (?, 'skeleton', 'x', 'fam', 1, 4, 12000, ?)")
    .run(documentId, Date.now())
}

const skeletonRows = (documentId: number): number =>
  (store.rawDb.prepare('SELECT count(*) AS c FROM document_skeleton WHERE document_id = ?').get(documentId) as { c: number }).c

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeleton-search-'))
  store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
  service = new SearchService({ store })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('skeleton hits in search results', () => {
  it('flags only skeleton documents, in both the lexical and the final callback', async () => {
    const skeletonId = seed('lesson-plan.docx', 'Giáo án tuần mười: phân số và số thập phân')
    seed('worksheet.docx', 'Phiếu bài tập tuần mười: phân số cơ bản')
    markSkeleton(skeletonId)

    const seen: Array<{ phase: string; flagged: string[] }> = []
    const hits = await service.searchProgressive('phân số', 8, {
      onLexical: (h) => seen.push({ phase: 'lexical', flagged: h.filter((x) => x.skeletonIndex).map((x) => x.name) }),
      onFinal: (h) => seen.push({ phase: 'final', flagged: h.filter((x) => x.skeletonIndex).map((x) => x.name) }),
    })

    const names = hits.map((h) => h.name)
    expect(names).toContain('lesson-plan.docx')
    expect(names).toContain('worksheet.docx')
    const flagged = hits.filter((h) => h.skeletonIndex)
    expect(flagged.map((h) => h.name)).toEqual(['lesson-plan.docx'])
    expect(flagged[0]).toMatchObject({ skeletonIndex: true, skeletonNotice: SKELETON_NOTICE })
    expect(seen).toEqual([
      { phase: 'lexical', flagged: ['lesson-plan.docx'] },
      { phase: 'final', flagged: ['lesson-plan.docx'] },
    ])
  })

  it('does not change hit order or content versus the same index without the skeleton mark', async () => {
    const id = seed('a-plan.docx', 'Kế hoạch bài dạy phân số lớp bốn')
    seed('b-plan.docx', 'Kế hoạch bài dạy phân số lớp năm')
    const strip = (hits: Awaited<ReturnType<SearchService['searchProgressive']>>) =>
      hits.map(({ skeletonIndex: _a, skeletonNotice: _b, ...rest }) => rest)
    const before = strip(await service.searchProgressive('phân số', 8))
    markSkeleton(id)
    const after = strip(await service.searchProgressive('phân số', 8))
    expect(after).toEqual(before)
  })

  it('adds nothing when no document is a skeleton', async () => {
    seed('plain.docx', 'Biên bản họp phụ huynh')
    const hits = await service.searchProgressive('phụ huynh', 8)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.skeletonIndex)).toBe(false)
  })

  it('reaches the chat source chips and the model context as an OUTLINE tag', async () => {
    const id = seed('lesson-plan.docx', 'Giáo án phân số')
    markSkeleton(id)
    const hits = await service.searchProgressive('phân số', 8)
    expect(hitsToSources(hits)).toEqual([expect.objectContaining({ name: 'lesson-plan.docx', skeletonIndex: true })])
    expect(buildRetrievalContext(hits).block).toContain('OUTLINE')
  })

  it('opening re-hydrates: retry/read-now marks it pending, the re-extraction removes the skeleton and the flag', async () => {
    const id = seed('lesson-plan.docx', 'Giáo án phân số — chỉ còn khung')
    markSkeleton(id)
    expect((await service.searchProgressive('phân số', 8))[0]?.skeletonIndex).toBe(true)

    const path = store.retryDocument(id) // what manager.retryDocument / readNowDocument(id) call first
    expect(path).toBe(join(dir, 'lesson-plan.docx'))
    expect(store.documentById(id)!.status).toBe('pending')
    expect(skeletonRows(id)).toBe(1) // still a skeleton until the worker has re-read the ORIGINAL file

    // the worker re-extracts the full original: a new active chunk set
    store.replaceDocument(path!, {
      hash: 'h-full',
      mtimeMs: 2000,
      sizeBytes: 5000,
      chunks: [
        { text: 'Giáo án phân số: mục tiêu bài học', location: 'Page 1' },
        { text: 'Giáo án phân số: hoạt động khởi động và luyện tập', location: 'Page 2' },
      ],
      status: 'ready',
    })
    expect(skeletonRows(id)).toBe(0)
    const rehydrated = await service.searchProgressive('phân số', 8)
    expect(rehydrated.some((h) => h.name === 'lesson-plan.docx')).toBe(true)
    expect(rehydrated.some((h) => h.skeletonIndex)).toBe(false)
  })

  it('opening a skeleton document from the result list queues the re-read of the original (and only for skeletons)', async () => {
    const skeletonId = seed('lesson-plan.docx', 'Giáo án phân số')
    const plainId = seed('worksheet.docx', 'Phiếu bài tập phân số')
    markSkeleton(skeletonId)

    expect(service.open(plainId)).toBe(join(dir, 'worksheet.docx'))
    expect(store.documentById(plainId)!.status).toBe('ready')

    expect(service.open(skeletonId)).toBe(join(dir, 'lesson-plan.docx'))
    expect(store.documentById(skeletonId)!.status).toBe('pending') // incompletePaths() hands it to the normal read queue
    expect(store.incompletePaths()).toContain(join(dir, 'lesson-plan.docx'))
    expect(skeletonRows(skeletonId)).toBe(1) // until the re-extraction lands
  })

  it('uses the manager retry/read-now hook when one is wired, and a vanished original is neither re-queued nor lost', async () => {
    const onSkeletonOpened = vi.fn()
    const wired = new SearchService({ store, onSkeletonOpened })
    const id = seed('lesson-plan.docx', 'Giáo án phân số')
    markSkeleton(id)
    expect(wired.open(id)).toBe(join(dir, 'lesson-plan.docx'))
    expect(onSkeletonOpened).toHaveBeenCalledExactlyOnceWith(id)
    expect(store.documentById(id)!.status).toBe('ready')

    const gone = seed('gone.docx', 'Biên bản phân số')
    markSkeleton(gone)
    rmSync(join(dir, 'gone.docx'))
    expect(wired.open(gone)).toBeNull()
    expect(onSkeletonOpened).toHaveBeenCalledTimes(1)
    expect(skeletonRows(gone)).toBe(1) // the skeleton index is kept; nothing is destroyed for a file that cannot be re-read
  })
})
