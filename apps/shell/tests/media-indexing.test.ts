import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { SearchService } from '../src/main/document-memory/runtime/search-service'
import { FreshnessCoordinator } from '../src/main/document-memory/runtime/freshness-coordinator'
import { FolderScanManager, isIndexablePath } from '../src/main/document-memory/folder-scan'
import { MediaMetadataFiller } from '../src/main/document-memory/media/media-filler'
import { selectImageOcrCandidates, markImageOcr, IMAGE_OCR_STATE } from '../src/main/document-memory/media/media-ocr-gate'
import { isSensitiveName } from '../src/main/document-memory/media/sensitive-names'
import { parseMediaIntent } from '../src/main/document-memory/media/media-query'
import { mediaCounts } from '../src/main/document-memory/media/media-repository'
import type { SyncMetadataGuard } from '../src/main/document-memory/runtime/sync-metadata-admission'
import { StandaloneSyncMetadataGuard, SyncMetadataAdmissionCoordinator } from '../src/main/document-memory/runtime/sync-metadata-admission'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import { createStorageBudget, type StorageBudgetSnapshot } from '../src/main/document-memory/storage-budget'
import { gif, jpeg, mkv, mp4, png, writeSparse } from './helpers/media-fixtures'

let dir: string
let store: DocumentMemoryStore
let freshness: FreshnessCoordinator
let scanners: FolderScanManager[]

const PHOTO_BYTES = 40_000

function open(options: ConstructorParameters<typeof DocumentMemoryStore>[1] = {}) {
  store = new DocumentMemoryStore(join(dir, 'document-memory.db'), options)
  freshness = new FreshnessCoordinator({ store })
}

function scanner(options?: { maxMediaPerFolder?: number }) {
  const instance = new FolderScanManager(
    join(dir, 'state'),
    {
      indexDiscoveredFile: (path, meta) => freshness.indexDiscoveredFile(path, meta),
      reconcileFolder: (root, files) => freshness.reconcileFolder(root, files),
    },
    options,
  )
  scanners.push(instance)
  return instance
}

async function scan(root: string, instance = scanner()) {
  instance.start(root)
  const started = Date.now()
  while (instance.status().running) {
    if (Date.now() - started > 8000) throw new Error('scan timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return instance
}

function file(rel: string, header: Buffer, bytes = PHOTO_BYTES, mtime?: Date): string {
  const path = join(dir, 'lib', rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeSparse(path, header, bytes)
  if (mtime) utimesSync(path, mtime, mtime)
  return path
}

const root = () => join(dir, 'lib')
const rows = () =>
  store.rawDb
    .prepare(
      `SELECT d.name, d.status, d.mtime_ms, d.size_bytes, d.priority_at, d.chunk_total, m.kind, m.container, m.width, m.height,
              m.duration_ms, m.taken_ms, m.ts_ms, m.meta_state, m.sensitive, m.ocr_candidate
       FROM documents d JOIN document_media m ON m.document_id = d.id ORDER BY d.name`,
    )
    .all() as Array<Record<string, any>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-media-'))
  scanners = []
  open()
})

afterEach(() => {
  for (const instance of scanners) instance.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('media enrollment through the real folder scan', () => {
  it('lists images and videos as finished name+metadata rows and fills their headers in the background', async () => {
    file('Pictures/Trip 2017/IMG_20170316_101010.jpg', jpeg(4032, 3024, { exifDate: '2017:03:16 10:10:10' }))
    file('Pictures/screen.png', png(1920, 1080))
    file('Videos/clip.mp4', mp4({ width: 1280, height: 720, seconds: 90, mdatBytes: 20_000 }), 140_000)
    file('Videos/movie.mkv', mkv({ width: 1920, height: 800, seconds: 3600 }), 60_000)
    file('Docs/report.txt', Buffer.from('plain text'))
    await scan(root())

    const before = rows()
    expect(before).toHaveLength(4)
    for (const row of before) {
      expect(row).toMatchObject({ status: 'ready', priority_at: 0, chunk_total: 0, meta_state: 0 })
      expect(row.mtime_ms).not.toBeNull()
      expect(row.size_bytes).toBeGreaterThan(0)
    }

    expect(await freshness.drainMediaMetadata()).toBe(4)
    const after = Object.fromEntries(rows().map((row) => [row.name, row]))
    expect(after['IMG_20170316_101010.jpg']).toMatchObject({
      kind: 'image', container: 'jpeg', width: 4032, height: 3024, meta_state: 1, ocr_candidate: 1,
      taken_ms: new Date(2017, 2, 16, 10, 10, 10).getTime(),
    })
    expect(after['IMG_20170316_101010.jpg']!.ts_ms).toBe(after['IMG_20170316_101010.jpg']!.taken_ms)
    expect(after['screen.png']).toMatchObject({ container: 'png', width: 1920, height: 1080 })
    expect(after['clip.mp4']).toMatchObject({ kind: 'video', container: 'mp4', width: 1280, height: 720, duration_ms: 90_000, ocr_candidate: 0 })
    expect(after['movie.mkv']).toMatchObject({ container: 'mkv', width: 1920, height: 800, duration_ms: 3_600_000 })
    expect(await freshness.drainMediaMetadata()).toBe(0)

    // the plain document is a normal pending document, untouched by any of this
    expect(store.documentByPath(join(root(), 'Docs', 'report.txt'))?.status).toBe('pending')
  })

  it('counts media as done: never pending, never in incompletePaths, a breakdown shows them', async () => {
    file('a/one.jpg', jpeg(100, 100))
    file('a/two.png', png(100, 100))
    file('a/three.mp4', mp4({ width: 10, height: 10, seconds: 1, mdatBytes: 20_000 }), 50_000)
    await scan(root())
    await freshness.drainMediaMetadata()

    const progress = store.folderChunkProgress(root())
    expect(progress).toMatchObject({ totalFiles: 3, readyFiles: 3, pendingFiles: 0, errorFiles: 0, mediaFiles: 3 })
    expect(progress.releasedFiles).toBeUndefined()
    expect(progress.pendingFiles + (progress.releasedFiles ?? 0) + progress.readyFiles + progress.errorFiles).toBe(progress.totalFiles)
    expect(store.stats()).toMatchObject({ docs: 3, errors: 0 })
    expect(store.incompletePaths()).toEqual([])
    expect(mediaCounts(store.rawDb)).toMatchObject({ images: 2, videos: 1, pendingMetadata: 0, ocrCandidates: 2 })

    // a document next to them is the only thing that is still waiting
    writeFileSync(join(root(), 'a', 'notes.txt'), 'hello')
    await scan(root())
    expect(store.folderChunkProgress(root())).toMatchObject({ totalFiles: 4, readyFiles: 3, pendingFiles: 1, mediaFiles: 3 })
    expect(store.incompletePaths()).toEqual([join(root(), 'a', 'notes.txt')])
  })

  it('does nothing for an unchanged file and re-reads only when mtime or size changes', async () => {
    const path = file('p/photo.jpg', jpeg(800, 600), PHOTO_BYTES, new Date(2020, 0, 5))
    await scan(root())
    await freshness.drainMediaMetadata()
    const stored = store.documentByPath(path)!
    const updatedAt = (store.rawDb.prepare('SELECT updated_at FROM documents WHERE id = ?').get(stored.id) as { updated_at: number }).updated_at

    const read = vi.fn(async () => ({ container: 'jpeg', width: 1, height: 1 }))
    const filler = new MediaMetadataFiller(store.rawDb, { read })
    const meta = { mtimeMs: stored.mtimeMs!, sizeBytes: stored.sizeBytes! }
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(freshness.indexDiscoveredFile(path, meta)).toBe(false) // same mtime+size: no work
      expect(await filler.drain()).toBe(0)
    }
    expect(read).not.toHaveBeenCalled()
    expect(rows()[0]).toMatchObject({ meta_state: 1, width: 800, height: 600 })
    expect((store.rawDb.prepare('SELECT updated_at FROM documents WHERE id = ?').get(stored.id) as { updated_at: number }).updated_at).toBe(updatedAt)
    expect(store.incompletePaths()).toEqual([])

    // the file is replaced: new header, new size
    writeSparse(path, jpeg(1024, 768), PHOTO_BYTES + 500)
    utimesSync(path, new Date(2021, 5, 6), new Date(2021, 5, 6))
    await scan(root())
    expect(rows()[0]).toMatchObject({ meta_state: 0, width: null, height: null })
    expect(store.documentByPath(path)).toMatchObject({ status: 'ready', sizeBytes: PHOTO_BYTES + 500 })
    await freshness.drainMediaMetadata()
    expect(rows()[0]).toMatchObject({ meta_state: 1, width: 1024, height: 768 })
  })

  it('keeps a corrupt or vanished file as a searchable, finished row that is not polled again', async () => {
    file('bad/broken.jpg', Buffer.from('this is not a jpeg at all'))
    const gone = file('bad/soon-gone.png', png(10, 10))
    await scan(root())
    unlinkSync(gone)
    await freshness.drainMediaMetadata()
    const byName = Object.fromEntries(rows().map((row) => [row.name, row]))
    expect(byName['broken.jpg']).toMatchObject({ status: 'ready', meta_state: 1, width: null, container: 'jpeg' })
    expect(byName['soon-gone.png']).toMatchObject({ status: 'ready', meta_state: 2 })
    expect(mediaCounts(store.rawDb).pendingMetadata).toBe(0)
    expect(store.searchNames('broken', 5).map((hit) => hit.name)).toEqual(['broken.jpg'])
  })

  it('removes the media row when the file is deleted (refresh), and keeps it while the file exists', async () => {
    const keep = file('x/keep.jpg', jpeg(10, 10))
    const drop = file('x/drop.jpg', jpeg(10, 10))
    const instance = await scan(root())
    expect(rows()).toHaveLength(2)
    unlinkSync(drop)
    expect(await instance.reconcile(root())).toMatchObject({ ok: true })
    expect(rows().map((row) => row.name)).toEqual(['keep.jpg'])
    expect(store.rawDb.prepare('SELECT count(*) AS n FROM document_media').get()).toEqual({ n: 1 })
    expect(store.documentByPath(keep)).not.toBeNull()
  })
})

describe('noise guards', () => {
  it('skips tiny images, thumbnail / cache / app-resource folders and bundles, but not documents there', async () => {
    file('ok/photo.jpg', jpeg(100, 100))
    file('ok/icon.png', png(16, 16), 4_000) // below 16 KB: an icon
    file('ok/tiny-video.mp4', mp4({ width: 10, height: 10, seconds: 1, mdatBytes: 100 }), 2_000) // videos have no floor
    for (const noise of ['.thumbnails', 'thumbnails', '@eaDir', '__MACOSX', 'Pictures.photoslibrary/originals', 'Movie.imovielibrary', 'Library/Caches', 'Cache', 'Caches', 'node_modules/pkg', 'assets', 'res/drawable-xhdpi', 'drawable', 'mipmap-hdpi', 'icons', 'sprites', 'app/site-packages', '.Trash', 'Trash'])
      file(`${noise}/x.jpg`, jpeg(100, 100))
    writeFileSync(join(root(), 'assets', 'readme.txt'), 'documents in an assets folder are still indexed')
    await scan(root())
    expect(rows().map((row) => row.name)).toEqual(['photo.jpg', 'tiny-video.mp4'])
    expect(store.documentByPath(join(root(), 'assets', 'readme.txt'))).not.toBeNull()
  })

  it('applies the same rule to live watcher events (isIndexablePath)', () => {
    const r = '/data'
    expect(isIndexablePath(r, '/data/Photos/a.JPG')).toBe(true)
    expect(isIndexablePath(r, '/data/Photos/a.mov')).toBe(true)
    expect(isIndexablePath(r, '/data/Photos/a.svg')).toBe(false)
    expect(isIndexablePath(r, '/data/Music/a.mp3')).toBe(false)
    expect(isIndexablePath(r, '/data/Photos/.hidden.jpg')).toBe(false)
    expect(isIndexablePath(r, '/data/.private/a.jpg')).toBe(false)
    expect(isIndexablePath(r, '/data/thumbnails/a.jpg')).toBe(false)
    expect(isIndexablePath(r, '/data/Library/Caches/a.jpg')).toBe(false)
    expect(isIndexablePath(r, '/data/x.photoslibrary/a.jpg')).toBe(false)
    expect(isIndexablePath(r, '/data/assets/archive.zip')).toBe(false)
    expect(isIndexablePath(r, '/data/assets/logo.png')).toBe(false) // media in an app-resource folder
    expect(isIndexablePath(r, '/data/assets/readme.docx')).toBe(true)
    // documents keep their allowlist
    expect(isIndexablePath(r, '/data/Docs/a.pdf')).toBe(true)
    expect(isIndexablePath(r, '/data/Docs/a.zip')).toBe(false)
  })

  it('caps media per source folder and says so instead of silently dropping files', async () => {
    for (let i = 0; i < 6; i++) file(`many/p${i}.jpg`, jpeg(100, 100))
    file('many/doc.txt', Buffer.from('still a document'))
    const instance = await scan(root(), scanner({ maxMediaPerFolder: 4 }))
    expect(rows()).toHaveLength(4)
    const [folder] = instance.folders()
    expect(folder).toMatchObject({ media: 4, mediaSkipped: 2, mediaTruncated: true })
    expect(store.documentByPath(join(root(), 'many', 'doc.txt'))).not.toBeNull()

    const roomy = scanner()
    roomy.start(root())
    // a roomy scanner for the same root is a different manifest only conceptually; a fresh one starts clean
    expect(roomy.folders().find((f) => f.mediaTruncated)).toBeUndefined()
  })
})

describe('search', () => {
  const find = (query: string, limit = 5) => store.searchNames(query, limit)
  const names = (query: string, limit = 5) => find(query, limit).map((hit) => hit.name)

  beforeEach(async () => {
    file('Ảnh gia đình/Du lịch Đà Lạt/IMG_20170316_101010.jpg', jpeg(4032, 3024, { exifDate: '2017:03:16 10:10:10' }), PHOTO_BYTES, new Date(2017, 2, 16, 10))
    file('Ảnh gia đình/Du lịch Đà Lạt/hoa hồng.png', png(800, 600), PHOTO_BYTES, new Date(2018, 0, 2))
    file('Camera/PXL_9.jpg', jpeg(300, 200), PHOTO_BYTES, new Date(2019, 7, 20, 9))
    file('Camera/Ảnh chụp màn hình 2024-05-06 lúc 10.11.12.png', png(1440, 900), PHOTO_BYTES, new Date(2024, 4, 6))
    file('Camera/scan hợp đồng thuê nhà.jpg', jpeg(2480, 3508), PHOTO_BYTES, new Date(2022, 9, 9))
    file('Videos/Sinh nhật bé.mp4', mp4({ width: 1920, height: 1080, seconds: 125, mdatBytes: 20_000 }), 150_000, new Date(2021, 11, 25))
    file('Videos/phỏng vấn.mov', mp4({ width: 1280, height: 720, seconds: 3000, brand: 'qt  ', mdatBytes: 20_000 }), 150_000, new Date(2023, 2, 4))
    file('Docs/Hợp đồng thuê nhà 2017-03-16.txt', Buffer.from('hợp đồng'))
    // the date is only in the name: the file was copied years later, so its mtime says 2024
    file('Camera/IMG_20150101_235959.jpg', jpeg(640, 480), PHOTO_BYTES, new Date(2024, 5, 5))
    await scan(root())
    await freshness.drainMediaMetadata()
  })

  it('finds media by file name and folder, diacritic-insensitively, with dimensions / duration for the UI', () => {
    expect(names('hoa hong')).toEqual(['hoa hồng.png'])
    expect(names('hoa hồng')).toEqual(['hoa hồng.png'])
    expect(names('Đà Lạt')).toEqual(expect.arrayContaining(['hoa hồng.png', 'IMG_20170316_101010.jpg']))
    expect(names('sinh nhat')).toEqual(['Sinh nhật bé.mp4'])
    const [hit] = find('sinh nhat')
    expect(hit!.media).toMatchObject({ kind: 'video', width: 1920, height: 1080, durationMs: 125_000, container: 'mp4', ocrCandidate: false, sensitive: false })
    expect(hit!.text).toContain('2:05')
    expect(hit!.text).toContain('never analyzed')
    expect(hit).toMatchObject({ chunkId: 0, location: 'file name', contentUnread: true })
    const [photo] = find('hoa hong')
    expect(photo!.media).toMatchObject({ kind: 'image', width: 800, height: 600, ocrCandidate: true })
  })

  it('answers type words: ảnh / hình / video / phim / clip / screenshot / scan, with or without accents', () => {
    const images = ['IMG_20170316_101010.jpg', 'hoa hồng.png', 'PXL_9.jpg', 'scan hợp đồng thuê nhà.jpg']
    for (const query of ['ảnh', 'anh', 'hình ảnh', 'hinh anh', 'photo']) {
      const got = names(query, 8)
      expect(got.some((name) => images.includes(name)), query).toBe(true)
      expect(got.every((name) => !name.endsWith('.mp4') && !name.endsWith('.mov') || query === 'anh'), query).toBe(true)
    }
    for (const query of ['video', 'phim', 'clip', 'videos']) {
      expect(names(query, 8).sort(), query).toEqual(['Sinh nhật bé.mp4', 'phỏng vấn.mov'].sort())
    }
    expect(names('video sinh nhật')).toEqual(['Sinh nhật bé.mp4'])
    expect(names('ảnh hoa hồng')).toContain('hoa hồng.png')
    expect(names('screenshot')).toEqual([]) // no file called screenshot exists
    expect(names('ảnh chụp màn hình')[0]).toBe('Ảnh chụp màn hình 2024-05-06 lúc 10.11.12.png')
    expect(names('scan hợp đồng')).toContain('scan hợp đồng thuê nhà.jpg')
    expect(names('png')).toEqual(expect.arrayContaining(['hoa hồng.png']))
    expect(names('png').every((n) => n.toLowerCase().endsWith('.png'))).toBe(true)
    expect(names('mov')).toEqual(['phỏng vấn.mov'])
  })

  it('answers dates by capture date / file mtime and by dated names', () => {
    for (const query of ['2017-03-16', '16/03/2017', '16-03-2017', '20170316']) {
      expect(names(query, 8), query).toContain('IMG_20170316_101010.jpg')
    }
    expect(names('ảnh 16/03/2017')[0]).toBe('IMG_20170316_101010.jpg') // the photo first; the dated document may follow
    expect(names('ảnh tháng 3 2017')[0]).toBe('IMG_20170316_101010.jpg')
    expect(names('ảnh tháng 3/2017')[0]).toBe('IMG_20170316_101010.jpg')
    expect(names('thang 8 2019')).toEqual(['PXL_9.jpg']) // only the file mtime says August 2019
    expect(names('video 12/2021')).toEqual(['Sinh nhật bé.mp4'])
    expect(names('ảnh 2018-01-02')).toEqual(['hoa hồng.png'])
    expect(names('ảnh tháng 4 2017')).toEqual([])
    expect(names('ảnh 2015-01-01')).toEqual(['IMG_20150101_235959.jpg']) // dated name, undated mtime
    expect(names('ảnh 01/01/2015')).toEqual(['IMG_20150101_235959.jpg'])
    expect(names('ảnh tháng 1 2015')).toEqual(['IMG_20150101_235959.jpg'])
    expect(names('ảnh tháng 6 2024')).toEqual(['IMG_20150101_235959.jpg']) // mtime only
    // the dated document is still found by its name for the same date, and is not displaced by photos
    expect(names('2017-03-16', 8)).toContain('Hợp đồng thuê nhà 2017-03-16.txt')
  })

  it('works through the SearchService entry point the app uses', async () => {
    const service = new SearchService({ store })
    const hits = await service.searchProgressive('video phim', 8)
    expect(hits.map((hit) => hit.name)).toEqual(expect.arrayContaining(['Sinh nhật bé.mp4']))
    expect(hits.find((hit) => hit.name === 'Sinh nhật bé.mp4')?.media?.durationMs).toBe(125_000)
  })

  it('does not treat ordinary document queries as media queries', () => {
    expect(parseMediaIntent('hợp đồng thuê nhà')).toBeNull()
    expect(parseMediaIntent('HD0433')).toBeNull()
    expect(parseMediaIntent('hợp đồng 2017')).toBeNull()
    expect(parseMediaIntent('ảnh 16/03/2017')).toMatchObject({ kind: 'image', words: [] })
    expect(names('thuê nhà')).toEqual(expect.arrayContaining(['Hợp đồng thuê nhà 2017-03-16.txt']))
  })
})

describe('privacy: sensitive marker and the OCR gates', () => {
  it('flags identity / legal / credential names, diacritic-insensitively and on whole words', () => {
    for (const name of ['CCCD mặt trước.jpg', 'cmnd_nguyen_van_a.png', 'căn cước công dân.jpg', 'Chứng minh nhân dân.jpg', 'passport.jpeg', 'Hộ chiếu 2024.jpg', 'sổ hộ khẩu.png', 'so ho khau.png', 'sổ đỏ nhà.jpg', 'Giấy khai sinh bé An.jpg', 'bằng lái xe.jpg', 'Giấy phép lái xe.jpg', 'thẻ ngân hàng.png', 'ATM card.jpg', 'stk vietcombank.png', 'OTP 123.png', 'mật khẩu wifi.jpg', 'my password.png', 'CanCuoc.jpg', 'ho_chieu.jpg'])
      expect(isSensitiveName(name), name).toBe(true)
    for (const name of ['atmosphere.jpg', 'Du lịch Đà Lạt.jpg', 'optical.png', 'IMG_2017.jpg', 'stkx.png', 'hoa hồng.png'])
      expect(isSensitiveName(name), name).toBe(false)
    expect(isSensitiveName('scan 1.jpg', '/home/a/CCCD/scan 1.jpg')).toBe(true) // a sensitive folder marks what is inside
    expect(isSensitiveName('scan 1.jpg', '/home/a/Pictures/scan 1.jpg')).toBe(false)
  })

  it('stores the marker on media rows and exposes it on search hits', async () => {
    file('papers/CCCD mặt trước.jpg', jpeg(1000, 700))
    file('papers/Trip.jpg', jpeg(1000, 700))
    await scan(root())
    const byName = Object.fromEntries(rows().map((row) => [row.name, row]))
    expect(byName['CCCD mặt trước.jpg']!.sensitive).toBe(1)
    expect(byName['Trip.jpg']!.sensitive).toBe(0)
    expect(store.searchNames('cccd mat truoc', 3)[0]!.media).toMatchObject({ sensitive: true, ocrCandidate: true })
    expect(mediaCounts(store.rawDb).sensitive).toBe(1)
  })

  it('never offers images (or sensitive documents) to the cloud scanned-PDF reader', async () => {
    file('s/photo.jpg', jpeg(1000, 700))
    file('s/CCCD scan.jpg', jpeg(1000, 700))
    const scanned = join(root(), 's', 'bao cao scan.pdf')
    const idCard = join(root(), 's', 'cccd nguyen van a.pdf')
    for (const path of [scanned, idCard]) writeFileSync(path, '%PDF-1.4')
    await scan(root())
    for (const path of [scanned, idCard]) {
      store.rawDb.prepare("UPDATE documents SET status = 'empty', error = 'No readable text; scanned documents need OCR' WHERE path = ?").run(path)
    }
    // what Antigravity sees: PDFs only, sensitive ones left out
    expect(store.ocr.candidates(40).map((row) => row.path)).toEqual([scanned])
    expect(store.ocr.candidates(40, { includeSensitive: true }).map((row) => row.path).sort()).toEqual([idCard, scanned].sort())
    // a media row that was somehow marked like a scanned PDF is still excluded structurally
    store.rawDb.prepare("INSERT INTO documents(path, name, status, error, chunk_counted, mtime_ms, size_bytes) VALUES (?, 'x.pdf', 'empty', 'No readable text; scanned documents need OCR', 1, 1, 1)").run(join(root(), 'x.pdf'))
    const id = (store.rawDb.prepare('SELECT id FROM documents WHERE name = ?').get('x.pdf') as { id: number }).id
    store.rawDb.prepare("INSERT INTO document_media(document_id, kind) VALUES (?, 'image')").run(id)
    expect(store.ocr.candidates(40).map((row) => row.path)).toEqual([scanned])
  })

  it('image OCR selection is local-only by default; cloud needs an explicit opt-in and never gets sensitive images', async () => {
    file('s/receipt.jpg', jpeg(1000, 700))
    file('s/passport.jpg', jpeg(1000, 700))
    file('s/clip.mp4', mp4({ width: 10, height: 10, seconds: 1, mdatBytes: 100 }), 5_000)
    await scan(root())
    const local = selectImageOcrCandidates(store.rawDb, { engine: 'local' })
    expect(local.map((c) => basename(c.path)).sort()).toEqual(['passport.jpg', 'receipt.jpg'])
    expect(local.find((c) => c.path.endsWith('passport.jpg'))!.sensitive).toBe(true)
    expect(selectImageOcrCandidates(store.rawDb, { engine: 'cloud' })).toEqual([])
    expect(selectImageOcrCandidates(store.rawDb, { engine: 'cloud', cloudOptIn: false })).toEqual([])
    expect(selectImageOcrCandidates(store.rawDb, { engine: 'cloud', cloudOptIn: true }).map((c) => basename(c.path))).toEqual(['receipt.jpg'])
    // the local package marks what it has read; a changed file becomes a candidate again
    const receipt = local.find((c) => c.path.endsWith('receipt.jpg'))!
    markImageOcr(store.rawDb, receipt.documentId, IMAGE_OCR_STATE.done)
    expect(selectImageOcrCandidates(store.rawDb, { engine: 'local' }).map((c) => c.path.split('/').pop())).toEqual(['passport.jpg'])
    writeSparse(receipt.path, jpeg(1100, 700), PHOTO_BYTES + 10)
    await scan(root())
    expect(selectImageOcrCandidates(store.rawDb, { engine: 'local' }).map((c) => c.path.split('/').pop()).sort()).toEqual(['passport.jpg', 'receipt.jpg'])
  })
})

describe('extraction never turns a media row into pending work or an error', () => {
  it('ignores errors, retries and opens of a media path', async () => {
    const path = file('o/photo.jpg', jpeg(100, 100))
    await scan(root())
    store.markError(path, 'Cannot extract text from this document')
    expect(store.recordTransientError(path, 'busy')).toBe(false)
    await store.markErrorSliced(path, 'Cannot extract text from this document')
    expect(store.remember(path)).toBe(true)
    expect(store.documentByPath(path)).toMatchObject({ status: 'ready', error: null })
    expect(store.incompletePaths()).toEqual([])
    // opening an image that was never scanned enrolls it the same way (no pending row, no error row)
    const fresh = file('o/fresh.png', png(50, 50))
    expect(store.remember(fresh)).toBe(true)
    expect(store.documentByPath(fresh)?.status).toBe('ready')
    // an old "unreadable document" row for an image path is repaired by the next scan
    const legacy = file('o/legacy.png', png(50, 50))
    store.rawDb.prepare("INSERT INTO documents(path, name, status, error, chunk_counted) VALUES (?, 'legacy.png', 'error', 'Cannot extract text', 1)").run(legacy)
    await scan(root())
    expect(store.documentByPath(legacy)).toMatchObject({ status: 'ready', error: null })
  })

  it('leaves excluded media alone', async () => {
    const path = file('e/photo.jpg', jpeg(100, 100))
    await scan(root())
    store.exclude(path)
    expect(store.enrollMedia(path, 1, 99_999).outcome).toBe('excluded')
    expect(store.documentByPath(path)?.status).toBe('excluded')
  })
})

describe('storage admission', () => {
  function guard(deny: (doc: { name: string; lowPriority?: boolean }) => boolean) {
    const seen: Array<{ name: string; lowPriority?: boolean }> = []
    const g: SyncMetadataGuard = {
      ...new StandaloneSyncMetadataGuard('allow'),
      canWriteProjection: () => true,
      canAdmitNewDocument: (doc, bytes) => {
        seen.push({ name: doc.name, lowPriority: doc.lowPriority })
        return deny(doc)
          ? { admitted: false, reason: 'budget-full', estimatedBytes: bytes, error: 'full' }
          : { admitted: true, reason: 'ok', estimatedBytes: bytes }
      },
      settleCommit: () => undefined,
      rollbackCommit: () => undefined,
      isReady: () => true,
      getLastRejectionReason: () => undefined,
      close: () => undefined,
    }
    return { g, seen }
  }

  it('admits media through the existing guard as low priority, and refuses media before documents', async () => {
    store.close()
    const { g, seen } = guard((doc) => doc.lowPriority === true)
    open({ syncAdmission: g })
    file('adm/photo.jpg', jpeg(100, 100))
    file('adm/note.txt', Buffer.from('text'))
    await scan(root())
    expect(seen.find((s) => s.name === 'photo.jpg')?.lowPriority).toBe(true)
    expect(seen.find((s) => s.name === 'note.txt')?.lowPriority).toBeFalsy()
    expect(rows()).toHaveLength(0) // refused, nothing half-written
    expect(store.rawDb.prepare('SELECT count(*) AS n FROM documents WHERE name = ?').get('photo.jpg')).toEqual({ n: 0 })
    expect(store.documentByPath(join(root(), 'adm', 'note.txt'))).not.toBeNull() // the document got in
    expect(store.enrollMedia(join(root(), 'adm', 'photo.jpg'), 1, 50_000).outcome).toBe('refused')
  })
})

describe('protected identity guard: media and documents retain name admission', () => {
  function coordinator(usageRatio: number) {
    const budget = createStorageBudget(10_000_000)
    const used = Math.floor(10_000_000 * usageRatio)
    const snapshot = {
      databaseBytes: used, budgetBytes: 10_000_000, usageRatio, chunksBytes: 0, embeddingsBytes: 0, ftsBytes: 0, ocrBytes: 0,
      backupBytes: 0, reclaimableBytes: 0, limitState: usageRatio >= 1.1 ? 'full' : usageRatio >= 0.8 ? 'warning' : 'ok',
      totalManagedBytes: used, nameMetadataBytes: 0, measurementStatus: 'fresh', isDegraded: false,
    } as StorageBudgetSnapshot
    return new SyncMetadataAdmissionCoordinator({
      admission: new StorageAdmissionController(),
      getStorageBudget: () => budget,
      isWriteReady: () => true,
      refreshAccountingAsync: async () => snapshot,
      getStorageBudgetSnapshot: () => snapshot,
      getFreeDiskBytes: async () => 10_000_000_000,
      freeDiskHeadroomBytes: 0,
    })
  }

  it('admits media and document identities through the reserved name pool until the total hard cap', async () => {
    const results: Record<string, [boolean, boolean]> = {}
    for (const ratio of [0.5, 0.85, 0.95, 1.05, 1.15]) {
      const guard = coordinator(ratio)
      await new Promise((resolve) => setTimeout(resolve, 5)) // free-disk warm-up
      const media = guard.canAdmitNewDocument({ name: 'a.jpg', path: '/p/a.jpg', lowPriority: true }, 2048)
      const doc = guard.canAdmitNewDocument({ name: 'a.docx', path: '/p/a.docx' }, 2048)
      results[String(ratio)] = [media.admitted, doc.admitted]
      guard.close()
    }
    expect(results).toEqual({ '0.5': [true, true], '0.85': [true, true], '0.95': [true, true], '1.05': [true, true], '1.15': [false, false] })
  })
})

describe('legacy behaviour that must not change', () => {
  it('keeps the document allowlist and ignores audio, vector and archive files', async () => {
    file('mix/a.docx', Buffer.from('PK'))
    file('mix/b.pdf', Buffer.from('%PDF'))
    file('mix/c.svg', Buffer.from('<svg/>'), PHOTO_BYTES)
    file('mix/d.mp3', Buffer.from('ID3'), PHOTO_BYTES)
    file('mix/e.zip', Buffer.from('PK'), PHOTO_BYTES)
    file('mix/f.gif', gif(10, 10))
    await scan(root())
    const all = store.listDocuments().map((doc) => basename(doc.path)).sort()
    expect(all).toEqual(['a.docx', 'b.pdf', 'f.gif'])
  })
})
