import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { SearchService } from '../src/main/document-memory/runtime/search-service'

/**
 * Regression suite for real-corpus search defects (filename demotion, OR-only content queries,
 * per-document crowding, filler-only place names, grouped amounts and zero-padded codes).
 * Real SQLite through DocumentMemoryStore and the same SearchService entry point the app uses;
 * the documents are synthetic.
 */
describe('search quality regression', () => {
  let dir: string
  let store: DocumentMemoryStore
  let service: SearchService
  let nextHash = 0

  const add = async (name: string, chunks: string[]): Promise<string> => {
    const path = join(dir, name)
    writeFileSync(path, 'x', 'utf8')
    nextHash++
    await store.replaceDocumentSliced(path, {
      hash: `h${nextHash}`,
      mtimeMs: 1000 + nextHash,
      sizeBytes: 10,
      chunks: chunks.map((text, ordinal) => ({ id: nextHash * 100 + ordinal, ordinal, text, location: `p.${ordinal + 1}` })),
      embeddingModel: null,
      status: 'text-only',
    })
    return path
  }
  const search = (query: string, limit = 8) => service.searchProgressive(query, limit)
  const names = (hits: Array<{ name: string }>) => hits.map((h) => h.name)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-search-quality-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    service = new SearchService({ store })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('(2) file name matches are not demoted below content-only hits', () => {
    beforeEach(async () => {
      // Content-only documents repeat the phrase, so bm25 prefers them over the named file.
      for (let i = 1; i <= 4; i++) {
        await add(`Biên bản ${i}.docx`, [`quyết định quyết định quyết định số ${i} quyết định của hiệu trưởng`])
      }
      await add('Quyết định.docx', ['Nội dung văn bản gồm một quyết định duy nhất về nhân sự năm học mới.'])
    })

    it('ranks the file literally named like the query first', async () => {
      const hits = await search('quyết định')
      expect(names(hits)[0]).toBe('Quyết định.docx')
      expect(names(hits)).toContain('Biên bản 1.docx')
    })

    it('does the same for the accent-less query', async () => {
      expect(names(await search('quyet dinh'))[0]).toBe('Quyết định.docx')
    })

    it('lists the named document once, with its content snippet', async () => {
      const hits = await search('quyết định')
      const named = hits.filter((h) => h.name === 'Quyết định.docx')
      expect(named).toHaveLength(1)
      expect(named[0]!.chunkId).toBeGreaterThan(0)
    })
  })

  describe('(3) multi-word content queries prefer the phrase, then all words, then any word', () => {
    beforeEach(async () => {
      // Only two of the three words, repeated: strong bm25 but not every word (OR noise).
      for (let i = 1; i <= 6; i++) {
        await add(`noise-${i}.docx`, [`giấy giấy giấy giấy giấy tờ. nhận nhận nhận hàng ${i}`])
      }
      await add('all-words.docx', ['tiền được trả sau khi giấy tờ đủ và người ký nhận hàng'])
      await add('phrase.docx', ['Biên bản ghi rõ giấy nhận tiền của phụ huynh trong tháng chín.'])
    })

    it('puts the document holding the exact phrase first', async () => {
      const hits = await search('giấy nhận tiền')
      expect(names(hits)[0]).toBe('phrase.docx')
      expect(names(hits)[1]).toBe('all-words.docx')
    })

    it('behaves identically without accents and in upper case', async () => {
      expect(names(await search('giay nhan tien')).slice(0, 2)).toEqual(['phrase.docx', 'all-words.docx'])
      expect(names(await search('GIẤY NHẬN TIỀN')).slice(0, 2)).toEqual(['phrase.docx', 'all-words.docx'])
    })

    it('still falls back to any-word matches when no document has every word', async () => {
      const hits = await search('giấy nhận tiền xyzabc')
      expect(hits.length).toBeGreaterThan(0)
      expect(names(hits)).toContain('phrase.docx')
    })

    it('keeps single-word recall', async () => {
      const hits = await search('giấy', 20)
      expect(hits.length).toBeGreaterThanOrEqual(6)
    })

    it('returns nothing for words that are absent everywhere', async () => {
      expect(await search('qwertyuiop zxcvbnm')).toEqual([])
    })
  })

  describe('(4) a document cannot crowd the result list without semantic vectors', () => {
    it('keeps at most 2 chunks per document and fills with other documents', async () => {
      await add('long.docx', Array.from({ length: 8 }, (_, i) => `báo cáo doanh thu báo cáo doanh thu phần ${i}`))
      for (let i = 1; i <= 4; i++) await add(`other-${i}.docx`, [`một báo cáo doanh thu ngắn số ${i}`])
      const hits = await search('báo cáo doanh thu', 5)
      const fromLong = hits.filter((h) => h.name === 'long.docx')
      expect(fromLong.length).toBeGreaterThan(0)
      expect(fromLong.length).toBeLessThanOrEqual(2)
      expect(new Set(hits.map((h) => h.documentId)).size).toBeGreaterThanOrEqual(4)
      // the best chunk of the long document is not hidden
      expect(names(hits)).toContain('long.docx')
    })

    it('still returns up to the limit when only one document matches', async () => {
      await add('solo.docx', Array.from({ length: 6 }, (_, i) => `ngân sách dự kiến mục ${i}`))
      expect(await search('ngân sách', 5)).toHaveLength(5)
    })
  })

  describe('(5) short Vietnamese place names are not erased by filler removal', () => {
    it('finds a file named "Cái Bè" and content that mentions it', async () => {
      await add('Viettel Cái Bè 726.pdf', ['Trạm phát sóng tại huyện, báo cáo tháng.'])
      await add('Khác 1.docx', ['Tài liệu về cái nón và bè gỗ không liên quan.'])
      await add('Địa chỉ.docx', ['Trụ sở đặt tại thị trấn Cái Bè, tỉnh Tiền Giang.'])
      const hits = await search('Cái Bè')
      expect(names(hits)).toContain('Viettel Cái Bè 726.pdf')
      expect(names(hits)).toContain('Địa chỉ.docx')
      expect(names(hits).indexOf('Viettel Cái Bè 726.pdf')).toBeLessThan(names(hits).indexOf('Khác 1.docx') === -1 ? 99 : names(hits).indexOf('Khác 1.docx'))
    })

    it('accepts the accent-less spelling too', async () => {
      await add('Viettel Cái Bè 726.pdf', ['Trạm phát sóng.'])
      expect(names(await search('cai be'))).toContain('Viettel Cái Bè 726.pdf')
    })

    it('does not turn a pure question into broad name matches', async () => {
      await add('Báo cáo.docx', ['Nội dung hoàn toàn khác.'])
      expect(names(await search('có cái nào không'))).not.toContain('Báo cáo.docx')
    })
  })

  describe('(6) numbers and invoice codes', () => {
    it('matches grouped amounts and plain digits both ways', async () => {
      await add('grouped.xlsx', ['Tổng thanh toán 16.432.095 đồng cho kỳ này'])
      await add('plain.xlsx', ['Số tiền 16432095 được chuyển khoản'])
      await add('other.xlsx', ['Tổng 16.432.096 đồng, 99.999.999 đồng'])
      for (const q of ['16.432.095', '16,432,095', '16 432 095', '16432095']) {
        const hits = names(await search(q))
        expect(hits, q).toContain('grouped.xlsx')
        expect(hits, q).toContain('plain.xlsx')
        expect(hits, q).not.toContain('other.xlsx')
      }
    })

    it('does not invent matches for an absent amount', async () => {
      await add('grouped.xlsx', ['Tổng thanh toán 16.432.095 đồng'])
      expect(await search('99.999.999')).toEqual([])
      expect(await search('99999999')).toEqual([])
    })

    it('matches HD433 against HD0433 in content, in both directions', async () => {
      await add('a.docx', ['Hóa đơn HD0433 đã thanh toán'])
      await add('b.docx', ['Hóa đơn HD433 đã thanh toán'])
      await add('c.docx', ['Hóa đơn HD0434 chưa thanh toán'])
      for (const q of ['HD433', 'hd0433', 'HD00433']) {
        const hits = names(await search(q))
        expect(hits, q).toEqual(expect.arrayContaining(['a.docx', 'b.docx']))
        expect(hits, q).not.toContain('c.docx')
      }
    })

    it('matches HD433 against a file named HD0433 (and not HD0434)', async () => {
      await add('2017-03-16_HD0433.pdf', ['bản scan'])
      await add('2017-03-16_HD0434.pdf', ['bản scan'])
      const hits = names(await search('HD433'))
      expect(hits[0]).toBe('2017-03-16_HD0433.pdf')
      expect(hits).not.toContain('2017-03-16_HD0434.pdf')
      expect(names(await search('HD0433'))[0]).toBe('2017-03-16_HD0433.pdf')
    })

    it('does not apply zero tolerance to plain numbers', async () => {
      await add('n.docx', ['mã 0433 và mã 433'])
      await add('m.docx', ['mã 0434'])
      expect(names(await search('0433'))).toEqual(['n.docx'])
    })
  })
})
