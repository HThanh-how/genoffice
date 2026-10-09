import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { SearchService } from '../src/main/document-memory/runtime/search-service'
import { EMBEDDING_PROFILES, type EmbeddingProfileId } from '../src/main/document-memory/embedding-profiles'

/**
 * Whole retrieval path on a real SQLite store (FTS5 + stored vectors + the production fusion call
 * sites in store.search and SearchService.searchProgressive), for the base and the mid tier.
 * The "dense model" is a stand-in that, like a small embedding model, sees every code and amount
 * as the same blur, so only the lexical side can tell near-identical invoices apart.
 * Synthetic documents only.
 */
const NAMES = ['Nguyễn Văn An', 'Trần Thị Bích', 'Lê Quốc Cường', 'Phạm Minh Đức', 'Hoàng Thu Hà', 'Vũ Đình Khoa']
const DIM = 96

function blurVector(text: string): number[] {
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd').replace(/\d/g, '0')
  const v = new Array<number>(DIM).fill(0)
  for (let i = 0; i + 3 <= folded.length; i++) {
    let h = 0
    for (let j = 0; j < 3; j++) h = (h * 31 + folded.charCodeAt(i + j)) >>> 0
    v[h % DIM]! += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

const code = (i: number) => `HD-2024-${String(871 + i * 6).padStart(5, '0')}`
const amount = (i: number) => String(16432095 + i * 37119).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const invoiceText = (i: number) =>
  `Hóa đơn giá trị gia tăng số ${code(i)} ngày 15 tháng 3 năm 2024. Tổng thanh toán ${amount(i)} đồng. Bên bán Công ty TNHH Hòa Bình.`
const contractText = (name: string, i: number) =>
  `Hợp đồng lao động số ${100 + i}/2024 ký với ông bà ${name}, phòng kế toán, thời hạn 12 tháng.`

const CASES: Array<{ query: string; target: string }> = [
  { query: code(15), target: invoiceText(15) },
  { query: code(36), target: invoiceText(36) },
  { query: amount(15), target: invoiceText(15) },
  { query: amount(15).replaceAll('.', ''), target: invoiceText(15) },
  { query: 'nguyen van an', target: contractText(NAMES[0]!, 0) },
  { query: 'le quoc cuong', target: contractText(NAMES[2]!, 2) },
  { query: 'pham minh duc', target: contractText(NAMES[3]!, 3) },
]

describe.each(['base', 'mid'] as EmbeddingProfileId[])('exact-token retrieval end to end (%s tier)', (profileId) => {
  const spaceId = EMBEDDING_PROFILES[profileId].embeddingId
  let dir: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `genoffice-hybrid-e2e-${profileId}-`))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const texts: string[] = []
    for (let i = 0; i < 40; i++) texts.push(invoiceText(i))
    NAMES.forEach((name, i) => texts.push(contractText(name, i)))
    texts.forEach((text, i) => {
      const path = join(dir, `doc-${i}.txt`)
      writeFileSync(path, 'x')
      store.replaceDocument(path, {
        hash: `h${i}`,
        mtimeMs: 1 + i,
        sizeBytes: 1,
        chunks: [{ text, location: 'p.1', vector: blurVector(text) }],
        embeddingModel: spaceId,
        status: 'ready',
      })
    })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves the tier of the space the call sites pass on', () => {
    expect(EMBEDDING_PROFILES[profileId].tier).toBe(profileId === 'base' ? 'base' : 'mid')
  })

  it('searchLexical flags the strict stages of the plan', () => {
    const hits = store.searchLexical(code(15), 50)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.strict).toBe(true)
    // the exact phrase is strict; invoices that only share the wrong extra word ("hoa") come from the any-word fallback
    const names = store.searchLexical('nguyen van an hoa', 50)
    expect(names.some((hit) => hit.strict === false)).toBe(true)
    const phrase = store.searchLexical('nguyen van an', 50)
    expect(phrase[0]!.strict).toBe(true)
  })

  it('store.search keeps codes, amounts and diacritic-less names at rank 1', () => {
    for (const { query, target } of CASES) {
      const hits = store.search(query, blurVector(query), 8, spaceId)
      expect(hits[0]?.text, query).toBe(target)
    }
  })

  it('SearchService.searchProgressive keeps them at rank 1 in the final list', async () => {
    const service = new SearchService({ store, askEmbed: async (text) => blurVector(text) })
    for (const { query, target } of CASES) {
      const finalHits = await service.searchProgressive(query, 8, undefined, spaceId)
      expect(finalHits[0]?.text, query).toBe(target)
      expect(finalHits.map((h) => h.text), query).toContain(target)
    }
  })
})
