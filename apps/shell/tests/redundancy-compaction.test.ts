import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chunkDocumentTextV2 } from '../src/main/document-memory/chunks'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { executeCacheRetentionPolicy } from '../src/main/document-memory/runtime/cache-retention-policy'
import { SearchService } from '../src/main/document-memory/runtime/search-service'
import { analyzeRedundancyFully } from '../src/main/document-memory/runtime/redundancy-analyzer'
import {
  freeSpaceForImportantDoc,
  planDisplacement,
  runRedundancyCompaction,
} from '../src/main/document-memory/runtime/redundancy-compaction'
import { releaseSkeletonsIfRoom } from '../src/main/document-memory/runtime/skeleton-rehydration'
import { releaseEvictedVectorsIfRoom } from '../src/main/document-memory/runtime/vector-eviction-release'
import { collectStorageAccountingAsync } from '../src/main/document-memory/runtime/storage-accounting-async'
import { annotateSkeletonHits, SKELETON_NOTICE } from '../src/main/document-memory/storage/repositories/skeleton-repository'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

/**
 * End-to-end contract of the redundancy-aware ("smart janitor") compaction on a synthetic school corpus:
 * 3 subjects x 20 weeks of lesson plans that share ~88% template text, 20 important contracts/invoices, a few
 * exact copies and unrelated notes. Real SQLite through DocumentMemoryStore, the real SearchService entrypoint,
 * real physical file sizes (after wal_checkpoint(TRUNCATE) + incremental vacuum). The scenarios run in order and
 * share one database, like a person's index living through successive quota pressure.
 */
const PROFILE = EMBEDDING_PROFILES.standard

function vec(seed: number): number[] {
  let a = seed >>> 0
  const v: number[] = []
  let n = 0
  for (let i = 0; i < PROFILE.dimensions; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    const x = a / 4294967296 - 0.5
    v.push(x)
    n += x * x
  }
  return v.map((x) => x / Math.sqrt(n))
}

const SUBJECTS = [
  {
    name: 'Toán',
    dir: 'Toan',
    titles: ['Cộng trừ trong phạm vi 100', 'Bảng nhân hai', 'Bảng nhân ba', 'Bảng nhân bốn', 'Diện tích hình tròn', 'Bảng chia năm', 'Phép chia có dư', 'Số tròn trăm', 'So sánh các số', 'Đơn vị đo độ dài', 'Đơn vị đo khối lượng', 'Chu vi hình vuông', 'Hình chữ nhật', 'Góc vuông và góc không vuông', 'Tìm số bị chia', 'Giải toán bằng hai phép tính', 'Biểu thức có dấu ngoặc', 'Thống kê số liệu', 'Xem đồng hồ', 'Ôn tập cuối học kì'],
  },
  {
    name: 'Ngữ văn',
    dir: 'Ngu van',
    titles: ['Chiếc áo len ấm áp', 'Bạn của nai nhỏ', 'Chú sẻ và bông hoa bằng lăng', 'Cô giáo lớp em', 'Người thầy cũ', 'Mùa thu trong trẻo', 'Giọt sương đầu ngày', 'Cây đa quê hương', 'Chuyện bốn mùa', 'Bài thơ về trường em', 'Chiếc bút mực', 'Sự tích dưa hấu', 'Người mẹ hiền', 'Chú bé chăn bò', 'Tiếng ru của bà', 'Con đường đến trường', 'Bác sĩ sói', 'Chợ hoa ngày Tết', 'Hạt gạo làng ta', 'Ôn tập đọc hiểu'],
  },
  {
    name: 'Tiếng Anh',
    dir: 'Tieng Anh',
    titles: ['Hello and goodbye', 'My family', 'Our school bag', 'Colours and shapes', 'Animals at the zoo', 'My favourite food', 'Weather today', 'Daily routines', 'At the market', 'Sports and games', 'My house', 'Clothes we wear', 'Days of the week', 'Body parts', 'Transport', 'Birthday party', 'In the park', 'School subjects', 'Seasons', 'Review unit'],
  },
] as const

const SECTIONS = ['I. MỤC TIÊU', 'II. CHUẨN BỊ', 'III. HOẠT ĐỘNG DẠY HỌC', 'Hoạt động 1: Khởi động', 'Hoạt động 2: Khám phá', 'Hoạt động 3: Luyện tập', 'IV. ĐIỀU CHỈNH SAU BÀI DẠY']
const STEMS = [
  'hướng dẫn học sinh quan sát tranh minh họa và nêu nhận xét ban đầu về nội dung',
  'tổ chức cho học sinh thảo luận theo cặp, đại diện các nhóm trình bày kết quả trước lớp',
  'yêu cầu học sinh hoàn thành phiếu bài tập vào vở và tự đánh giá mức độ hoàn thành',
  'quan sát, ghi chép, hỗ trợ kịp thời những em còn gặp khó khăn trong quá trình học',
  'nhận xét, tuyên dương học sinh tích cực và dặn dò chuẩn bị cho tiết học tiếp theo',
]

function boilerplate(subject: string): string[] {
  const out: string[] = []
  for (const section of SECTIONS) {
    out.push(section)
    STEMS.forEach((stem, i) =>
      out.push(`Giáo viên môn ${subject} ${stem}, thuộc phần ${section.toLowerCase().replace(/[^\p{L} ]+/gu, '')} mục ${'abcde'[i]}.`),
    )
  }
  return out
}

function lessonText(subjectIdx: number, week: number): string {
  const s = SUBJECTS[subjectIdx]!
  const title = s.titles[week - 1]!
  const lines = boilerplate(s.name)
  const unique = [
    `Ví dụ minh họa của bài ${title}: học sinh luyện tập với bộ đồ dùng riêng của tuần này.`,
    `Trọng tâm kiến thức ${title} gắn với tình huống thực tế số ${week * 7} trong lớp.`,
    `Phiếu bài tập ${title} dành cho nhóm học sinh cần hỗ trợ thêm.`,
  ]
  const at = lines.indexOf('Hoạt động 2: Khám phá') + 1
  lines.splice(at, 0, ...unique)
  const head = [
    `GIÁO ÁN ${s.name.toUpperCase()} LỚP 3`,
    `Tuần ${week} - Bài ${week * 2}: ${title}`,
    `Môn: ${s.name}   Lớp: 3A   Tiết ${(week % 3) + 1}`,
    `Chủ đề: ${title}`,
  ]
  return [...head, ...lines].join('\n\n')
}

function contractText(i: number): string {
  const clauses = Array.from({ length: 14 }, (_, n) => `Điều ${n + 1}. Các bên cam kết thực hiện đầy đủ nghĩa vụ theo quy định của pháp luật về lao động, bảo hiểm và an toàn lao động.`)
  return [
    `HỢP ĐỒNG LAO ĐỘNG số HD-${4000 + i}/2026`,
    `Bên A: Công ty TNHH Mẫu ${i}. Bên B: Nguyễn Văn Thử ${i}, mức lương ${10 + i}.500.000 đồng một tháng.`,
    ...clauses,
  ].join('\n\n')
}

function invoiceText(i: number): string {
  return [
    `Hóa đơn điện tử số 00${700 + i}`,
    `Khách hàng: Công ty Cổ phần Khách ${i}. Mã số thuế 03${i}1234567.`,
    `Số tiền thanh toán: ${i + 2}.350.000 đồng.`,
    'Cảm ơn quý khách đã sử dụng dịch vụ. Hóa đơn được lập theo quy định hiện hành của Bộ Tài chính.',
    'Mọi thắc mắc xin liên hệ bộ phận chăm sóc khách hàng trong vòng ba mươi ngày kể từ ngày lập hóa đơn.',
  ].join('\n\n')
}

/** Ordinary (not protected) sales invoices: same template, only numbers and the customer change. */
function salesInvoiceText(i: number): string {
  return [
    `HÓA ĐƠN BÁN HÀNG số 0${100 + i}`,
    `Khách hàng: Cửa hàng Z${i}. Mã số thuế 0${i}0123456.`,
    'Hàng hóa đã được giao đầy đủ, đúng chủng loại và số lượng ghi trong đơn đặt hàng của quý khách.',
    'Quý khách kiểm tra hàng hóa ngay khi nhận; mọi khiếu nại về chất lượng phải được lập biên bản tại chỗ.',
    'Thời hạn thanh toán là ba mươi ngày kể từ ngày xuất hóa đơn, quá hạn sẽ tính lãi theo mức quy định.',
    'Hình thức thanh toán bằng chuyển khoản qua tài khoản ngân hàng của công ty được ghi ở cuối hóa đơn này.',
    ...Array.from({ length: 12 }, (_, n) => `Điều khoản bán hàng mục ${'abcdefghijkl'[n]}: bên bán và bên mua cùng tuân thủ quy định về giao nhận, kiểm đếm, bảo hành và thanh toán đã thỏa thuận trước đó.`),
    'Bảng giá niêm yết đã bao gồm thuế giá trị gia tăng theo quy định hiện hành của Bộ Tài chính.',
    `Số tiền thanh toán: ${i + 3}.480.000 đồng.`,
    'Chính sách đổi trả: hàng được đổi trong bảy ngày nếu còn nguyên bao bì và đầy đủ phụ kiện đi kèm.',
    'Xin cảm ơn quý khách đã tin dùng sản phẩm và dịch vụ, hẹn gặp lại quý khách trong những lần mua sắm tới.',
    'Mọi chi tiết xin liên hệ bộ phận chăm sóc khách hàng, giờ làm việc từ thứ hai đến thứ sáu hằng tuần.',
  ].join('\n\n')
}

function noteText(i: number): string {
  const words = ['thư viện', 'sân trường', 'phòng y tế', 'ngày hội đọc sách', 'quỹ lớp', 'phụ huynh', 'chuyến dã ngoại', 'bảng tin', 'cuộc thi vẽ', 'câu lạc bộ cờ vua', 'tổ chuyên môn', 'sổ chủ nhiệm']
  const w = words[i % words.length]!
  return Array.from({ length: 14 }, (_, n) => `Ghi chú ${i}.${n}: bàn về ${w}, ý kiến riêng số ${i * 31 + n * 7} của giáo viên và đề xuất cải tiến ${w} trong năm học này.`).join('\n\n')
}

let dir: string
let dbPath: string
let store: DocumentMemoryStore
let budget = 0
let seed = 1
const metrics: Record<string, unknown> = {}

interface Doc {
  path: string
  kind: 'lesson' | 'contract' | 'invoice' | 'note' | 'copy' | 'extra'
  text: string
  subject?: number
  week?: number
}
const docs: Doc[] = []

function addDoc(doc: Doc, override?: 'important' | 'low', mtime?: number): void {
  const chunks = chunkDocumentTextV2(doc.text).map((c) => ({ ...c, vector: vec(seed++) }))
  store.replaceDocument(doc.path, {
    hash: `h-${doc.path.length}-${doc.text.length}-${seed}`,
    mtimeMs: mtime ?? Date.now() - docs.length * 3_600_000,
    sizeBytes: doc.text.length,
    chunks,
    embeddingModel: PROFILE.embeddingId,
    status: 'ready',
  })
  if (override) store.setImportanceOverride(doc.path, override)
  docs.push(doc)
}

const physical = async (): Promise<number> =>
  (await collectStorageAccountingAsync({ dbPath, db: store.rawDb })).totalManagedBytes

function fileBytes(): { db: number; wal: number; total: number } {
  store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  store.rawDb.exec('PRAGMA incremental_vacuum')
  store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const size = (p: string): number => {
    try {
      return statSync(p).size
    } catch {
      return 0
    }
  }
  const db = size(dbPath)
  const wal = size(`${dbPath}-wal`)
  return { db, wal, total: db + wal }
}

const lessonPath = (s: number, w: number): string => {
  const subj = SUBJECTS[s]!
  return resolve(dir, 'Giao an', subj.dir, `Giáo án ${subj.name} 3 - Tuần ${w} - Bài ${w * 2} - ${subj.titles[w - 1]}.docx`)
}
const docId = (path: string): number => store.documentByPath(path)!.id
const one = (sql: string, ...args: Array<string | number>): number =>
  (store.rawDb.prepare(sql).get(...args) as { c: number }).c

async function rankOf(query: string, path: string, limit = 8): Promise<number> {
  const service = new SearchService({ store })
  const hits = await service.searchProgressive(query, limit)
  if (process.env.DBG_RANK) console.info('[rank]', query, '=>', hits.map((h) => h.path.split('/').pop()).join(' | '))
  const i = hits.findIndex((h) => h.path === path)
  return i < 0 ? 0 : i + 1
}

/**
 * The queries a teacher actually types. Title/file-name queries must stay at rank 1 (a fixed bound). The loose ones
 * ("Toán tuần 3", "giáo án tuần 12") match many sibling files equally - their order is the search ranker's call - so
 * the contract is "never worse than before compaction" (baseline measured on the untouched index).
 */
const QUERIES = (): Array<{ q: string; path: string; max: number | 'baseline' }> => [
  { q: 'tuần 5 Diện tích hình tròn', path: lessonPath(0, 5), max: 1 },
  { q: 'tuan 5 dien tich hinh tron', path: lessonPath(0, 5), max: 1 },
  { q: 'giáo án tuần 12', path: lessonPath(0, 12), max: 'baseline' },
  { q: 'giao an tuan 12 Hình chữ nhật', path: lessonPath(0, 13), max: 'baseline' },
  { q: 'Toán tuần 3', path: lessonPath(0, 3), max: 'baseline' },
  { q: 'tuan 3 toan Bảng nhân ba', path: lessonPath(0, 3), max: 1 },
  { q: 'Ngữ văn tuần 8 Cây đa quê hương', path: lessonPath(1, 8), max: 1 },
  { q: 'tieng anh tuan 16 Birthday party', path: lessonPath(2, 16), max: 1 },
  { q: `Giáo án Ngữ văn 3 - Tuần 11 - Bài 22 - Chiếc bút mực.docx`, path: lessonPath(1, 11), max: 1 },
]

const baselineRanks = new Map<string, number>()

async function expectQueriesFound(label: string): Promise<void> {
  for (const { q, path, max } of QUERIES()) {
    const rank = await rankOf(q, path)
    expect(rank, `${label}: "${q}" -> ${path.split('/').pop()}`).toBeGreaterThan(0)
    if (label.startsWith('before')) {
      baselineRanks.set(q, rank)
      if (typeof max === 'number') expect(rank, `${label}: "${q}" baseline`).toBeLessThanOrEqual(max)
    } else {
      const bound = max === 'baseline' ? baselineRanks.get(q)! : max
      expect(rank, `${label}: "${q}" rank`).toBeLessThanOrEqual(bound)
    }
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'redundancy-compaction-'))
  dbPath = join(dir, 'document-memory.db')
  store = new DocumentMemoryStore(dbPath, { role: 'worker' })
  store.ensureEmbeddingSpace(PROFILE)
  for (const sub of SUBJECTS) mkdirSync(join(dir, 'Giao an', sub.dir), { recursive: true })
  // 60 lesson plans (same template per subject)
  for (let s = 0; s < SUBJECTS.length; s++)
    for (let w = 1; w <= 20; w++) addDoc({ path: lessonPath(s, w), kind: 'lesson', text: lessonText(s, w), subject: s, week: w })
  // exact copies: same folder "Bản sao" and another folder "(1)"
  for (const [s, w] of [[0, 7], [1, 9]] as const) {
    addDoc({ path: lessonPath(s, w).replace('.docx', ' - Bản sao.docx'), kind: 'copy', text: lessonText(s, w), subject: s, week: w })
  }
  for (const [s, w] of [[0, 15], [2, 18]] as const) {
    const sub = SUBJECTS[s]!
    addDoc({ path: resolve(dir, 'Sao luu', `Giáo án ${sub.name} 3 - Tuần ${w} - Bài ${w * 2} - ${sub.titles[w - 1]} (1).docx`), kind: 'copy', text: lessonText(s, w), subject: s, week: w })
  }
  // 20 important documents: 10 contracts (important by name inference) + 10 invoices (explicit override)
  for (let i = 1; i <= 10; i++)
    addDoc({ path: resolve(dir, 'Hop dong', `Hợp đồng lao động - Nguyễn Văn Thử ${i}.docx`), kind: 'contract', text: contractText(i) })
  for (let i = 1; i <= 10; i++)
    addDoc({ path: resolve(dir, 'Hoa don', `Hóa đơn điện tử số 00${700 + i} - Công ty Khách ${i}.pdf`), kind: 'invoice', text: invoiceText(i) }, 'important')
  // 6 ordinary sales invoices (NOT protected): a template family whose numbers must stay searchable
  for (let i = 1; i <= 6; i++)
    addDoc({ path: resolve(dir, 'Hoa don ban', `Hóa đơn bán hàng số 0${100 + i} - Cửa hàng Z${i}.pdf`), kind: 'extra', text: salesInvoiceText(i), week: i })
  // unrelated unique notes: must keep everything
  for (let i = 1; i <= 12; i++)
    addDoc({ path: resolve(dir, 'Ghi chu', `Ghi chú họp tổ ${['thư viện', 'sân trường', 'y tế', 'hội đọc', 'quỹ lớp', 'phụ huynh', 'dã ngoại', 'bảng tin', 'thi vẽ', 'cờ vua', 'chuyên môn', 'chủ nhiệm'][i - 1]}.docx`), kind: 'note', text: noteText(i) })
})

afterAll(() => {
  try {
    // before/after sizes for humans: REDUNDANCY_METRICS_OUT=/path/file.json npx vitest run tests/redundancy-compaction.test.ts
    if (process.env.REDUNDANCY_METRICS_OUT) writeFileSync(process.env.REDUNDANCY_METRICS_OUT, JSON.stringify(metrics, null, 2))
  } catch {
    // ignore
  }
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('redundancy-aware compaction on a school corpus', () => {
  let importantSnapshot: Array<{ path: string; chunks: string; vectors: number }> = []
  let miscVectors = 0

  it('1. near the quota: frees >= target (90% -> 80%), spares important and unique documents', async () => {
    const importants = docs.filter((d) => d.kind === 'contract' || d.kind === 'invoice')
    expect(importants).toHaveLength(20)
    const snapshot = (path: string): { path: string; chunks: string; vectors: number } => ({
      path,
      chunks: JSON.stringify(
        store.rawDb.prepare('SELECT ordinal, text FROM chunks WHERE document_id = ? ORDER BY ordinal').all(docId(path)),
      ),
      vectors: one('SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE c.document_id=?', docId(path)),
    })
    importantSnapshot = importants.map((d) => snapshot(d.path))
    miscVectors = one(
      "SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN documents d ON d.id=c.document_id WHERE d.path LIKE '%Ghi chu%'",
    )
    await expectQueriesFound('before compaction')

    const before = fileBytes()
    budget = Math.round(before.total / 0.93)
    const target = before.total - budget * 0.8
    metrics.corpus = {
      documents: one('SELECT count(*) AS c FROM documents'),
      chunks: one('SELECT count(*) AS c FROM chunks'),
      vectors: one('SELECT count(*) AS c FROM chunk_embeddings'),
      physicalBefore: before,
      budget,
    }

    const rep = await executeCacheRetentionPolicy(store.rawDb, dbPath, budget, {
      measurePhysicalBytes: physical,
      onPostCommitAnnInvalidation: (s) => s.forEach((x) => store.invalidateAnnInMemory(x.spaceId)),
    })
    expect(rep.error).toBeUndefined()
    expect(rep.triggered).toBe(true)
    expect(rep.targetReached).toBe(true)
    expect(rep.bytesAfter).toBeLessThanOrEqual(budget * 0.8)
    expect(rep.contentEvictedDocsCount).toBe(0)
    expect(rep.tier2LowImportanceDocsPruned + rep.tier3NormalDocsPruned).toBe(0) // the janitor sufficed: no blunt LRU
    expect(rep.redundancy?.stoppedReason).toBe('target-reached')
    const after = fileBytes()
    const freed = before.total - after.total
    expect(freed).toBeGreaterThanOrEqual(target)
    expect(rep.redundancy!.tiers.vectors.documents).toBeGreaterThan(40)
    expect(rep.redundancy!.families.found).toBeGreaterThanOrEqual(3)
    expect(JSON.parse(JSON.stringify(rep.redundancy))).toEqual(rep.redundancy) // plain JSON for the dashboard
    metrics.step1 = { physicalAfter: after, freed, target, report: rep.redundancy }

    // important documents are byte-identical (text and vectors); unique notes keep every vector
    expect(importants.map((d) => snapshot(d.path))).toEqual(importantSnapshot)
    expect(
      one(
        "SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN documents d ON d.id=c.document_id WHERE d.path LIKE '%Ghi chu%'",
      ),
    ).toBe(miscVectors)
    for (const d of importants) expect(one('SELECT count(*) AS c FROM document_skeleton WHERE document_id = ?', docId(d.path))).toBe(0)
    expect(one("SELECT count(*) AS c FROM document_vector_evictions m JOIN documents d ON d.id=m.document_id WHERE d.path LIKE '%Hop dong%' OR d.path LIKE '%Hoa don%'")).toBe(0)

    // lesson plans lost vectors (boilerplate chunks), all text/FTS still there
    const lessons = docs.filter((d) => d.kind === 'lesson')
    expect(one("SELECT count(*) AS c FROM document_skeleton WHERE stage = 'vectors'")).toBeGreaterThanOrEqual(40)
    expect(lessons.length).toBe(60)
    for (const d of lessons.slice(0, 5)) expect(store.searchLexical(d.text.split('\n\n')[1]!.slice(0, 40), 3).length).toBeGreaterThan(0)
    await expectQueriesFound('after T-A')
  }, 120_000)

  it('2. exact copies are recognised and the original is the cleanest-named one', () => {
    const rows = store.rawDb
      .prepare('SELECT d.path, r.duplicate_of FROM document_redundancy r JOIN documents d ON d.id = r.document_id WHERE r.duplicate_of IS NOT NULL')
      .all() as Array<{ path: string; duplicate_of: number }>
    expect(rows.length).toBe(4)
    for (const r of rows) {
      expect(/Bản sao|\(1\)/.test(r.path)).toBe(true)
      const original = store.documentById(r.duplicate_of)!
      expect(/Bản sao|\(1\)/.test(original.path)).toBe(false)
    }
  })

  it('3. admission by displacement: an important document that did not fit is admitted', async () => {
    const used = fileBytes().total
    // an incoming important contract bigger than the room that is left: sized on scratch stores so the number
    // is a real physical weight (text + FTS + vectors), not an estimate
    const clauses = (n: number): string =>
      Array.from({ length: n }, (_, i) => `Điều ${i + 1}. Bên thuê cam kết thanh toán khoản ${i + 5}.250.000 đồng vào ngày mồng năm hằng tháng theo phụ lục số ${i} đính kèm hợp đồng.`).join('\n\n')
    const incomingPath = resolve(dir, 'Hop dong', 'Hợp đồng thuê nhà mới.docx')
    const weigh = (n: number): number => {
      const p = join(dir, `scratch-${n}.db`)
      const scratch = new DocumentMemoryStore(p, { role: 'worker' })
      scratch.ensureEmbeddingSpace(PROFILE)
      scratch.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const empty = statSync(p).size
      scratch.replaceDocument(incomingPath, {
        hash: 'huge', mtimeMs: Date.now(), sizeBytes: 1, embeddingModel: PROFILE.embeddingId, status: 'ready',
        chunks: chunkDocumentTextV2(clauses(n)).map((c, i) => ({ ...c, vector: vec(900_000 + i) })),
      })
      scratch.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const size = statSync(p).size - empty
      scratch.close()
      return size
    }
    const perClause = weigh(200) / 200
    const room = budget - used
    const n = Math.ceil((room + budget * 0.04) / perClause)
    const needed = weigh(n)
    const hugeText = clauses(n)
    const hugeChunks = chunkDocumentTextV2(hugeText).map((c, i) => ({ ...c, vector: vec(900_000 + i) }))
    expect(used + needed).toBeGreaterThan(budget) // cannot be admitted as is

    const plan = planDisplacement(store.rawDb, needed)
    expect(plan.candidates.length).toBeGreaterThan(0)
    expect(plan.candidates.every((c) => !/Hop dong|Hoa don/.test(c.name) && !/Hợp đồng|Hóa đơn/.test(c.name))).toBe(true)
    for (let i = 1; i < plan.candidates.length; i++) expect(plan.candidates[i]!.density).toBeGreaterThanOrEqual(plan.candidates[i - 1]!.density)

    const res = await freeSpaceForImportantDoc(
      store.rawDb,
      { neededBytes: needed, budgetBytes: budget, incomingImportance: 'important' },
      { measurePhysicalBytes: physical },
    )
    expect(res.error).toBeUndefined()
    expect(res.status).toBe('freed')
    expect(res.satisfied).toBe(true)
    expect(res.fitsQuota).toBe(true)
    expect(res.freedBytes).toBeGreaterThanOrEqual(needed)
    // "frees what is needed": not the whole janitor budget (granularity = a couple of documents)
    expect(res.freedBytes).toBeLessThan(needed + budget * 0.06)
    expect(res.report!.tiers.skeleton.documents).toBeGreaterThan(0) // T-B had to run
    expect(one("SELECT count(*) AS c FROM document_skeleton WHERE stage = 'skeleton'")).toBeGreaterThan(0)

    // admit it for real; the physical total stays under the hard quota
    store.replaceDocument(incomingPath, {
      hash: 'huge', mtimeMs: Date.now(), sizeBytes: hugeText.length, chunks: hugeChunks, embeddingModel: PROFILE.embeddingId, status: 'ready',
    })
    const admitted = fileBytes().total
    expect(admitted).toBeLessThanOrEqual(budget)
    expect(store.searchLexical('thuê nhà', 3).length + store.searchNames('Hợp đồng thuê nhà mới', 3).length).toBeGreaterThan(0)
    expect(store.documentByPath(incomingPath)!.status).toBe('ready')
    metrics.displacement = { neededBytes: needed, usedBefore: res.usedBefore, usedAfter: res.usedAfter, freed: res.freedBytes, physicalAfterAdmission: admitted, report: res.report }
    // important docs are still byte-identical
    expect(docs.filter((d) => d.kind === 'contract' || d.kind === 'invoice').map((d) => ({
      path: d.path,
      chunks: JSON.stringify(store.rawDb.prepare('SELECT ordinal, text FROM chunks WHERE document_id = ? ORDER BY ordinal').all(docId(d.path))),
      vectors: one('SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE c.document_id=?', docId(d.path)),
    }))).toEqual(importantSnapshot)
  }, 180_000)

  it('4. lesson plans are still found by title, week, subject, file name (with and without diacritics)', async () => {
    await expectQueriesFound('after skeleton')
  }, 60_000)

  it('5. template-only queries may be gone, the file is still found and flagged as a skeleton', async () => {
    const skeletonDocs = store.rawDb
      .prepare("SELECT document_id FROM document_skeleton WHERE stage = 'skeleton'")
      .all() as Array<{ document_id: number }>
    expect(skeletonDocs.length).toBeGreaterThan(0)
    const skeletonSet = new Set(skeletonDocs.map((r) => r.document_id))
    const phrase = 'Giáo viên môn Toán nhận xét, tuyên dương học sinh tích cực và dặn dò chuẩn bị cho tiết học tiếp theo'
    // direct on the index: no skeleton document still holds the template sentence in chunks or FTS
    for (const id of skeletonSet) {
      const holds = store.rawDb.prepare("SELECT count(*) AS c FROM chunks WHERE document_id = ? AND text LIKE '%tuyên dương học sinh tích cực%'").get(id) as { c: number }
      expect(holds.c).toBe(0)
    }
    const hits = store.hydrateChunkHits(store.searchLexical(phrase, 200))
    // (lexical search is a ranked OR match, so skeleton documents may still hit on their title words;
    // what must be gone is the template sentence itself)
    expect(hits.filter((h) => skeletonSet.has(h.documentId) && h.text.includes('tuyên dương học sinh tích cực')).length).toBe(0)
    expect(hits.some((h) => !skeletonSet.has(h.documentId) && h.text.includes('tuyên dương học sinh tích cực'))).toBe(true) // still held by a non-skeleton sibling
    // ...yet a skeleton lesson is found by title and carries the notice
    const skeletonLesson = docs.find((d) => d.kind === 'lesson' && skeletonSet.has(docId(d.path)))!
    expect(skeletonLesson).toBeTruthy()
    const title = SUBJECTS[skeletonLesson.subject!]!.titles[skeletonLesson.week! - 1]!
    const service = new SearchService({ store })
    const found = await service.searchProgressive(`tuần ${skeletonLesson.week} ${title}`, 8)
    expect(found[0]?.path).toBe(skeletonLesson.path)
    const flagged = annotateSkeletonHits(store.rawDb, found)
    expect(flagged[0]).toMatchObject({ skeletonIndex: true, skeletonNotice: SKELETON_NOTICE })
    // the unique lesson content survived inside the skeleton
    expect(store.searchLexical(`phiếu bài tập ${title}`, 5).some((h) => skeletonSet.has(h.documentId))).toBe(true)
    // identity and consistency
    for (const id of skeletonSet) {
      expect(one('SELECT count(*) AS c FROM chunks WHERE document_id = ?', id)).toBeGreaterThanOrEqual(1)
    }
    expect((store.rawDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    expect(one('SELECT count(*) AS c FROM chunk_fts WHERE rowid NOT IN (SELECT id FROM chunks)')).toBe(0)
    expect(one('SELECT count(*) AS c FROM chunks WHERE id NOT IN (SELECT rowid FROM chunk_fts)')).toBe(0)
    expect(one('SELECT count(*) AS c FROM chunk_embeddings WHERE chunk_id NOT IN (SELECT id FROM chunks)')).toBe(0)
    expect(one('SELECT count(*) AS c FROM documents d WHERE chunk_done <> coalesce((SELECT completed_chunks FROM document_embedding_counts e WHERE e.document_id=d.id AND e.space_id=d.embedding_model),0)')).toBe(0)
    expect(one('SELECT count(*) AS c FROM documents d WHERE chunk_total <> (SELECT count(*) FROM chunks c WHERE c.document_id=d.id)')).toBe(0)
    metrics.skeleton = { documents: skeletonSet.size, chunksPerSkeleton: one("SELECT avg(kept_chunks) AS c FROM document_skeleton WHERE stage='skeleton'") }
  }, 60_000)

  it('6. no thrash: compacted documents are not pending work, poll/budget callbacks leave them alone', () => {
    const incomplete = new Set(store.incompletePaths())
    const marked = store.rawDb
      .prepare('SELECT d.path FROM document_vector_evictions m JOIN documents d ON d.id = m.document_id')
      .all() as Array<{ path: string }>
    for (const m of marked) expect(incomplete.has(m.path), m.path).toBe(false)
    const skel = store.rawDb.prepare("SELECT d.path, d.status FROM document_skeleton s JOIN documents d ON d.id = s.document_id").all() as Array<{ path: string; status: string }>
    for (const s of skel) expect(incomplete.has(s.path), s.path).toBe(false)
    // at 80% usage nothing is released / re-extracted (release needs < 60%)
    const usage = { limitState: 'ok', usedBytes: budget * 0.8, budgetBytes: budget, measurementStatus: 'fresh' }
    expect(releaseEvictedVectorsIfRoom(store.rawDb, usage).documents).toBe(0)
    expect(releaseSkeletonsIfRoom(store.rawDb, usage).documents).toBe(0)
  })

  it('7. idempotent and incremental: a second run changes nothing and re-analyses nothing', async () => {
    const snap = (): string =>
      JSON.stringify({
        chunks: store.rawDb.prepare('SELECT id, text FROM chunks ORDER BY id').all(),
        vectors: one('SELECT count(*) AS c FROM chunk_embeddings'),
        skeleton: store.rawDb.prepare('SELECT document_id, stage, kept_chunks, dropped_bytes FROM document_skeleton ORDER BY document_id').all(),
      })
    // drive everything redundant to its final state once, then run again
    await runRedundancyCompaction(store.rawDb, { measurePhysicalBytes: physical, targetFloorBytes: -1 })
    const settled = snap()
    const analysis = await analyzeRedundancyFully(store.rawDb, {})
    expect(analysis.fingerprintedChunks).toBe(0)
    expect(analysis.documentsRegistered).toBe(0)
    expect(analysis.documentsAnalyzed).toBe(0)
    const again = await runRedundancyCompaction(store.rawDb, { measurePhysicalBytes: physical, targetFloorBytes: -1 })
    expect(again.report.tiers.vectors.documents + again.report.tiers.skeleton.documents).toBe(0)
    expect(again.report.analysis?.documentsAnalyzed).toBe(0)
    expect(snap()).toBe(settled)
    // below the 90% trigger the policy is a no-op
    const used = await physical()
    const rep = await executeCacheRetentionPolicy(store.rawDb, dbPath, Math.round(used / 0.5), { measurePhysicalBytes: physical })
    expect(rep.triggered).toBe(false)
    expect(rep.stoppedReason).toBe('not-triggered')
    const final = fileBytes()
    metrics.final = { physical: final, ratioOfBudget: final.total / budget }

    // every document is now at its final stage: sales invoices became skeletons but their numbers are still found
    const invoices = docs.filter((d) => d.kind === 'extra')
    expect(invoices.length).toBe(6)
    expect(
      invoices.filter((d) => one("SELECT count(*) AS c FROM document_skeleton WHERE stage = 'skeleton' AND document_id = ?", docId(d.path)) === 1).length,
    ).toBeGreaterThanOrEqual(4)
    for (const d of invoices) {
      const i = d.week!
      expect(await rankOf(`Số tiền thanh toán ${i + 3}.480.000 đồng`, d.path), `amount of invoice ${i}`).toBeGreaterThan(0)
      expect(await rankOf(`hóa đơn bán hàng số 0${100 + i}`, d.path), `number of invoice ${i}`).toBe(1)
      expect(await rankOf(`Cửa hàng Z${i} mã số thuế 0${i}0123456`, d.path), `customer of invoice ${i}`).toBe(1)
      expect(one('SELECT count(*) AS c FROM chunks WHERE document_id = ? AND text LIKE ?', docId(d.path), '%tin dùng sản phẩm%')).toBe(0)
    }
    // copies keep identity + title only, the original keeps everything
    const copy = docs.find((d) => d.kind === 'copy')!
    const row = store.rawDb.prepare('SELECT duplicate_of FROM document_redundancy WHERE document_id = ?').get(docId(copy.path)) as { duplicate_of: number }
    expect(one('SELECT count(*) AS c FROM document_skeleton WHERE stage = \'skeleton\' AND document_id = ?', row.duplicate_of)).toBeLessThanOrEqual(1)
    expect(one('SELECT coalesce(sum(length(text)), 0) AS c FROM chunks WHERE document_id = ?', docId(copy.path))).toBeLessThan(
      one('SELECT coalesce(sum(length(text)), 0) AS c FROM chunks WHERE document_id = ?', row.duplicate_of) / 2,
    )
  }, 120_000)

  it('8. re-hydration: read-now / retry re-extracts the original and restores the full content', async () => {
    const skeletonLesson = docs.find((d) => d.kind === 'lesson' && one("SELECT count(*) AS c FROM document_skeleton WHERE stage='skeleton' AND document_id = ?", docId(d.path)) === 1)!
    const id = docId(skeletonLesson.path)
    const chunksBefore = one('SELECT count(*) AS c FROM chunks WHERE document_id = ?', id)
    const phrase = 'tuyên dương học sinh tích cực'
    const sentenceHolders = (): number => one(`SELECT count(*) AS c FROM chunks WHERE document_id = ? AND text LIKE '%${phrase}%'`, id)
    expect(sentenceHolders()).toBe(0)
    // what DocumentMemoryManager.readNowDocument does: retryDocument (pending), then the worker extracts the
    // untouched original and the store replaces the chunk set
    expect(store.retryDocument(id)).toBe(skeletonLesson.path)
    expect(store.incompletePaths()).toContain(skeletonLesson.path)
    expect(one('SELECT count(*) AS c FROM document_skeleton WHERE document_id = ?', id)).toBe(1) // not yet: extraction may fail
    const chunks = chunkDocumentTextV2(skeletonLesson.text).map((c) => ({ ...c, vector: vec(seed++) }))
    store.replaceDocument(skeletonLesson.path, {
      hash: store.documentByPath(skeletonLesson.path)!.hash ?? 'h', mtimeMs: Date.now(), sizeBytes: skeletonLesson.text.length,
      chunks, embeddingModel: PROFILE.embeddingId, status: 'ready',
    })
    expect(one('SELECT count(*) AS c FROM document_skeleton WHERE document_id = ?', id)).toBe(0)
    expect(one('SELECT count(*) AS c FROM chunks WHERE document_id = ?', id)).toBeGreaterThan(chunksBefore)
    expect(one('SELECT count(*) AS c FROM chunks WHERE document_id = ?', id)).toBe(chunks.length)
    expect(sentenceHolders()).toBeGreaterThan(0)
    expect(store.searchLexical('tuyên dương học sinh tích cực', 200).some((h) => h.documentId === id)).toBe(true)
    expect(one('SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE c.document_id = ?', id)).toBe(chunks.length)
    expect(one('SELECT count(*) AS c FROM document_vector_evictions WHERE document_id = ?', id)).toBe(0)
    expect(store.incompletePaths()).not.toContain(skeletonLesson.path)
    // plenty of room -> the maintenance release queues the other skeleton documents, bounded by recorded regrowth
    const room = releaseSkeletonsIfRoom(store.rawDb, { limitState: 'ok', usedBytes: budget * 0.3, budgetBytes: budget, measurementStatus: 'fresh' })
    expect(room.documents).toBeGreaterThan(0)
    expect(room.estimatedBytes).toBeLessThanOrEqual(budget * 0.45)
    for (const p of room.paths) expect(store.incompletePaths()).toContain(p)
  }, 60_000)
})

describe('redundancy compaction edge cases', () => {
  function miniStore(name: string): { st: DocumentMemoryStore; p: string; d: string } {
    const d = mkdtempSync(join(tmpdir(), `redundancy-edge-${name}-`))
    const p = join(d, 'document-memory.db')
    const st = new DocumentMemoryStore(p, { role: 'worker' })
    st.ensureEmbeddingSpace(PROFILE)
    return { st, p, d }
  }
  function put(st: DocumentMemoryStore, path: string, text: string, base: number, override?: 'important' | 'low'): void {
    st.replaceDocument(path, {
      hash: `e-${base}`,
      mtimeMs: Date.now() - base * 1000,
      sizeBytes: text.length,
      chunks: chunkDocumentTextV2(text).map((c, i) => ({ ...c, vector: vec(base * 100 + i) })),
      embeddingModel: PROFILE.embeddingId,
      status: 'ready',
    })
    if (override) st.setImportanceOverride(path, override)
  }
  const familyDoc = (week: number, unique: string): string =>
    [`Báo cáo tuần ${week}`, ...boilerplate('Toán'), `Nhận xét riêng của tuần ${week}: ${unique}.`].join('\n\n')

  it('nothing to displace: unique documents are never touched and the answer is "insufficient"', async () => {
    const { st, d } = miniStore('unique')
    try {
      for (let i = 1; i <= 8; i++) put(st, resolve(d, `Ghi chú riêng ${i}.docx`), noteText(i), i)
      const chunksBefore = (st.rawDb.prepare('SELECT count(*) AS c FROM chunks').get() as { c: number }).c
      const vectorsBefore = (st.rawDb.prepare('SELECT count(*) AS c FROM chunk_embeddings').get() as { c: number }).c
      const stats = await analyzeRedundancyFully(st.rawDb)
      expect(stats.complete).toBe(true)
      const plan = planDisplacement(st.rawDb, 10_000)
      expect(plan.candidates).toEqual([])
      expect(plan.sufficient).toBe(false)
      const res = await freeSpaceForImportantDoc(st.rawDb, { neededBytes: 500_000, budgetBytes: 600_000 })
      expect(res.status).toBe('insufficient')
      expect(res.freedBytes).toBe(0)
      expect((st.rawDb.prepare('SELECT count(*) AS c FROM chunks').get() as { c: number }).c).toBe(chunksBefore)
      expect((st.rawDb.prepare('SELECT count(*) AS c FROM chunk_embeddings').get() as { c: number }).c).toBe(vectorsBefore)
      // not needed when it fits comfortably
      expect((await freeSpaceForImportantDoc(st.rawDb, { neededBytes: 10, budgetBytes: 1_000_000_000 })).status).toBe('not-needed')
    } finally {
      st.close()
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('a cancelled run mutates nothing, and the classic critical force mode still spares important documents', async () => {
    const { st, d } = miniStore('force')
    try {
      for (let w = 1; w <= 8; w++) put(st, resolve(d, 'a', `Báo cáo tuần ${w}.docx`), familyDoc(w, `điểm nhấn số ${w}`), w)
      for (let w = 1; w <= 6; w++) put(st, resolve(d, 'b', `Hồ sơ tuần ${w}.docx`), familyDoc(w + 50, `điểm riêng số ${w}`), 100 + w, 'important')
      const snap = (): string =>
        JSON.stringify(st.rawDb.prepare('SELECT c.id, c.text, (SELECT count(*) FROM chunk_embeddings e WHERE e.chunk_id=c.id) v FROM chunks c ORDER BY c.id').all())
      const before = snap()
      const cancelled = await runRedundancyCompaction(st.rawDb, { targetFloorBytes: -1, shouldContinue: () => false })
      expect(cancelled.report.stoppedReason).toBe('cancelled')
      expect(snap()).toBe(before)

      const importantBefore = JSON.stringify(
        st.rawDb.prepare("SELECT c.id, c.text, (SELECT count(*) FROM chunk_embeddings e WHERE e.chunk_id=c.id) v FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.path LIKE '%/b/%' ORDER BY c.id").all(),
      )
      const rep = await executeCacheRetentionPolicy(st.rawDb, join(d, 'document-memory.db'), 1_000_000, {
        force: true,
        allowContentEviction: true,
        measurePhysicalBytes: () => 900_000,
      })
      expect(rep.error).toBeUndefined()
      expect(rep.redundancy?.tiers.vectors.documents).toBeGreaterThan(0)
      expect(rep.tier4ImportantDocsPruned).toBe(0)
      expect(
        JSON.stringify(
          st.rawDb.prepare("SELECT c.id, c.text, (SELECT count(*) FROM chunk_embeddings e WHERE e.chunk_id=c.id) v FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.path LIKE '%/b/%' ORDER BY c.id").all(),
        ),
      ).toBe(importantBefore)
      expect(st.rawDb.prepare("SELECT count(*) AS c FROM document_skeleton s JOIN documents d ON d.id=s.document_id WHERE d.path LIKE '%/b/%'").get()).toEqual({ c: 0 })
    } finally {
      st.close()
      rmSync(d, { recursive: true, force: true })
    }
  })
})
