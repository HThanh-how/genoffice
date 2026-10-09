import { describe, expect, it } from 'vitest'
import { copyPenalty, familyKeyFor, parseName } from '../src/main/document-memory/runtime/redundancy-family'
import {
  FamilyLineCounter,
  REDUNDANCY_DEFAULTS,
  emptyFamilyModel,
  planSkeleton,
  type PlanChunkInput,
} from '../src/main/document-memory/runtime/redundancy-plan'
import {
  chunkFingerprint,
  hasDistinctiveToken,
  isHeadingLike,
  isMarkerLine,
  lineKey,
  splitLines,
} from '../src/main/document-memory/runtime/redundancy-text'
import { computeValueDensity, type ValueInput } from '../src/main/document-memory/runtime/value-density'

describe('redundancy text primitives', () => {
  it('fingerprints ignore case, diacritics, digits and whitespace', () => {
    const a = chunkFingerprint('Học sinh làm bài tập số 5 trong vở.\nGiáo viên nhận xét 12 em.')
    const b = chunkFingerprint('hoc sinh lam bai tap so 9 trong vo. giao vien nhan xet 3 em.')
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(chunkFingerprint('12345 678')).toBeNull()
    expect(lineKey('Tuần 5')).toBe(lineKey('tuan 17'))
  })

  it('recognises locator lines in Vietnamese and English, but not running prose', () => {
    for (const line of ['Tuần 5', 'Bài 12: Diện tích hình tròn', 'Tiết 3', 'Chủ đề: Cộng trừ', 'Môn: Toán', 'Điều 4. Thời hạn', 'Unit 7 - Travel', 'Invoice No: 1234']) {
      expect(isMarkerLine(line), line).toBe(true)
    }
    expect(isMarkerLine('Học sinh làm bài tập vào vở và giáo viên nhận xét từng em một cách cẩn thận.')).toBe(false)
  })

  it('detects heading-like lines and identifier-like tokens', () => {
    expect(isHeadingLike('I. MỤC TIÊU')).toBe(true)
    expect(isHeadingLike('Hoạt động 2: Khám phá')).toBe(true)
    expect(isHeadingLike('Học sinh làm bài tập vào vở và giáo viên nhận xét từng em.')).toBe(false)
    expect(hasDistinctiveToken('Số tiền: 1.200.000 đồng')).toBe(true)
    expect(hasDistinctiveToken('Hóa đơn HD-0231')).toBe(true)
    expect(hasDistinctiveToken('Học sinh làm 5 bài tập')).toBe(false)
  })

  it('splits long paragraphs at sentence ends', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Câu số ${i} nói về nội dung bài học hôm nay.`).join(' ')
    const lines = splitLines(`Tiêu đề\n\n${long}`)
    expect(lines[0]).toBe('Tiêu đề')
    expect(lines.length).toBeGreaterThan(2)
    expect(lines.every((l) => l.length <= 800)).toBe(true)
  })
})

describe('document families', () => {
  it('groups week files of one folder and separates subjects, copies join the family', () => {
    const dir = '/tmp/x/Giao an/Toan'
    const k1 = familyKeyFor(`${dir}/Giáo án Toán 3 - Tuần 5 - Bài 10 - Diện tích hình tròn.docx`)
    const k2 = familyKeyFor(`${dir}/Giáo án Toán 3 - Tuần 12 - Bài 24 - Phép chia có dư.docx`)
    const k3 = familyKeyFor(`${dir}/Giáo án Toán 3 - Tuần 12 - Bài 24 - Phép chia có dư - Bản sao.docx`)
    const k4 = familyKeyFor(`${dir}/Giáo án Toán 3 - Tuần 7 - Bài 14 (1).docx`)
    const other = familyKeyFor('/tmp/x/Giao an/Van/Giáo án Văn 3 - Tuần 5 - Bài 10 - Kể chuyện.docx')
    expect(k1).toBe(k2)
    expect(k1).toBe(k3)
    expect(k1).toBe(k4)
    expect(other).not.toBe(k1)
    expect(parseName('Hợp đồng lao động - Nguyễn A (1).docx').hasCopyMarker).toBe(true)
    expect(copyPenalty('Giáo án - Bản sao.docx')).toBe(1)
    expect(copyPenalty('Giáo án.docx')).toBe(0)
  })
})

describe('skeleton selection', () => {
  const template = [
    'I. MỤC TIÊU',
    'Học sinh biết cách thực hiện các bước của bài học và vận dụng vào thực tế cuộc sống hằng ngày.',
    'II. CHUẨN BỊ',
    'Giáo viên chuẩn bị tranh ảnh, phiếu bài tập và bảng phụ; học sinh chuẩn bị sách vở, bút thước đầy đủ.',
    'III. HOẠT ĐỘNG',
    'Giáo viên tổ chức cho học sinh hoạt động nhóm, đại diện các nhóm trình bày kết quả trước lớp.',
    'Giáo viên nhận xét, tuyên dương và dặn dò học sinh chuẩn bị cho tiết học sau.',
  ]
  const doc = (week: number, topic: string): PlanChunkInput[] => [
    { id: week * 10 + 1, ordinal: 0, globalBoiler: false, text: `GIÁO ÁN TOÁN\nTuần ${week} - Bài ${week * 2}: ${topic}\n${template.slice(0, 3).join('\n')}` },
    { id: week * 10 + 2, ordinal: 1, globalBoiler: false, text: `${template.slice(3).join('\n')}\nVí dụ riêng của bài về ${topic} có nhiều hình vẽ minh họa.` },
    { id: week * 10 + 3, ordinal: 2, globalBoiler: false, text: template.concat(template).join('\n') },
  ]

  it('keeps title, locator and unique lines and drops the template', () => {
    const counter = new FamilyLineCounter()
    const topics = ['hình tròn', 'phép chia', 'bảng nhân', 'số thập phân', 'phân số']
    topics.forEach((t, i) => counter.addDocument(doc(i + 1, t).flatMap((c) => splitLines(c.text))))
    const model = { ...emptyFamilyModel('f'), boiler: new Set(counter.derivedBoilerplate(REDUNDANCY_DEFAULTS)), exactFreq: counter.exact, sampleDocs: counter.docs }
    const plan = planSkeleton(doc(9, 'tỉ lệ bản đồ'), model)
    const kept = plan.chunks.map((c, i) => (c.action === 'drop' ? '' : (c.newText ?? doc(9, 'tỉ lệ bản đồ')[i]!.text))).join('\n')
    expect(kept).toContain('Tuần 9 - Bài 18: tỉ lệ bản đồ')
    expect(kept).toContain('tỉ lệ bản đồ có nhiều hình vẽ')
    expect(kept).not.toContain('Giáo viên tổ chức cho học sinh hoạt động nhóm')
    expect(plan.boilerplateRatio).toBeGreaterThan(0.6)
    expect(plan.chunks[0]!.action).not.toBe('drop')
    expect(plan.droppedChars).toBeGreaterThan(plan.keptChars)
    // the all-template chunk is removed entirely, never the whole document
    expect(plan.counts.drop).toBeGreaterThanOrEqual(1)
    expect(plan.counts.drop).toBeLessThan(plan.chunks.length)
  })

  it('never evicts the only chunk of a document and keeps amounts/ids of repeated invoices', () => {
    const one = planSkeleton([{ id: 1, ordinal: 0, globalBoiler: true, text: 'Dòng lặp lại rất nhiều lần\nDòng lặp khác' }], emptyFamilyModel('f'))
    expect(one.chunks.every((c) => c.action === 'keep')).toBe(true)
    const inv = (n: number): PlanChunkInput[] => [
      { id: n * 10, ordinal: 0, globalBoiler: false, text: `Công ty TNHH Mẫu\nĐịa chỉ giao hàng theo hợp đồng khung\nSố tiền: ${n}.200.000 đồng\nMã hóa đơn HD-0${n}31` },
      { id: n * 10 + 1, ordinal: 1, globalBoiler: false, text: 'Cảm ơn quý khách đã sử dụng dịch vụ của chúng tôi và hẹn gặp lại' },
    ]
    const counter = new FamilyLineCounter()
    for (const n of [1, 2, 3, 4]) counter.addDocument(inv(n).flatMap((c) => splitLines(c.text)))
    const model = { ...emptyFamilyModel('f'), boiler: new Set(counter.derivedBoilerplate(REDUNDANCY_DEFAULTS)), exactFreq: counter.exact, sampleDocs: 4 }
    const plan = planSkeleton(inv(7), model)
    const text = plan.chunks.map((c, i) => (c.action === 'drop' ? '' : (c.newText ?? inv(7)[i]!.text))).join('\n')
    expect(text).toContain('7.200.000')
    expect(text).toContain('HD-0731')
  })
})

describe('value density', () => {
  const base: ValueInput = {
    importance: 'normal',
    lastTouchMs: Date.now(),
    opened: false,
    nowMs: Date.now(),
    boilerplateRatio: 0,
    familySize: 1,
    isDuplicate: false,
    textBytes: 10_000,
    vectorBytes: 5_000,
  }
  it('prefers keeping important, recent, opened, unique and small documents', () => {
    const d = (o: Partial<ValueInput>): number => computeValueDensity({ ...base, ...o })
    expect(d({ importance: 'important' })).toBeGreaterThan(d({}))
    expect(d({ importance: 'low' })).toBeLessThan(d({}))
    expect(d({ lastTouchMs: base.nowMs - 400 * 86_400_000 })).toBeLessThan(d({}))
    expect(d({ opened: true })).toBeGreaterThan(d({}))
    expect(d({ boilerplateRatio: 0.85, familySize: 20 })).toBeLessThan(d({}) * 0.3)
    expect(d({ isDuplicate: true })).toBeLessThan(d({ boilerplateRatio: 0.85, familySize: 20 }))
    expect(d({ textBytes: 100_000 })).toBeLessThan(d({}))
  })
})
