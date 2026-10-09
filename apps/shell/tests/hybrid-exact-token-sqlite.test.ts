import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { lexicalMatchPlan } from '../src/main/document-memory/lexical-query'
import { fuseHybridResultIds, isStrictLexicalStage, type RankedCandidate } from '../src/main/document-memory/hybrid-ranker'

/**
 * Real SQLite FTS5 (the app's lexical plan) + a deliberately fuzzy "dense" ranker (hashed character
 * trigrams, which like a small embedding model treats HD-2024-00871 and HD-2024-00817 as near twins).
 * Synthetic documents only.
 */
const NAMES = ['Nguyễn Văn An', 'Trần Thị Bích', 'Lê Quốc Cường', 'Phạm Minh Đức', 'Hoàng Thu Hà', 'Vũ Đình Khoa']

function trigramVector(text: string): Float64Array {
  // Embedding models barely encode digits (the benchmark's dense-only nDCG on bare codes and amounts
  // is 0.01-0.15), so the stand-in sees every code and amount as the same blur.
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd').replace(/\d/g, '0')
  const v = new Float64Array(256)
  for (let i = 0; i + 3 <= folded.length; i++) {
    let h = 0
    for (let j = 0; j < 3; j++) h = (h * 31 + folded.charCodeAt(i + j)) >>> 0
    v[h % 256]! += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}
const dotp = (a: Float64Array, b: Float64Array) => a.reduce((s, x, i) => s + x * b[i]!, 0)

describe('exact-token queries on real SQLite lexical hits', () => {
  let dir: string
  let store: DocumentMemoryStore
  const chunkText = new Map<number, string>()
  const chunkOf = new Map<string, number>()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-exact-token-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const db = (store as unknown as { rawDb: import('node:sqlite').DatabaseSync }).rawDb
    const texts: string[] = []
    // 40 near-identical invoices: only the code and the amount differ
    for (let i = 0; i < 40; i++) {
      const code = `HD-2024-${String(871 + i * 6).padStart(5, '0')}`
      const amount = String(16432095 + i * 37119).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
      texts.push(`Hóa đơn giá trị gia tăng số ${code} ngày 15 tháng 3 năm 2024. Tổng thanh toán ${amount} đồng. Bên bán Công ty TNHH Hòa Bình.`)
    }
    // people mentioned in contracts
    NAMES.forEach((name, i) => texts.push(`Hợp đồng lao động số ${100 + i}/2024 ký với ông bà ${name}, phòng kế toán, thời hạn 12 tháng.`))
    texts.forEach((text, i) => {
      const path = join(dir, `doc-${i}.txt`)
      writeFileSync(path, 'x')
      store.replaceDocument(path, { hash: `h${i}`, mtimeMs: 1 + i, sizeBytes: 1, chunks: [{ text, location: 'p.1' }], embeddingModel: null, status: 'text-only' })
    })
    const rows = db.prepare('SELECT c.id, c.text FROM chunks c').all() as Array<{ id: number; text: string }>
    for (const row of rows) {
      chunkText.set(row.id, row.text)
      chunkOf.set(row.text, row.id)
    }
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function rank(query: string, targetText: string, gated: boolean): number {
    const db = (store as unknown as { rawDb: import('node:sqlite').DatabaseSync }).rawDb
    const plan = lexicalMatchPlan(query)
    const strictIds = new Set<number>()
    plan.forEach((expr, stage) => {
      if (!isStrictLexicalStage(stage, plan.length)) return
      for (const row of db.prepare('SELECT rowid AS id FROM chunk_fts WHERE chunk_fts MATCH ? LIMIT 200').all(expr) as Array<{ id: number }>) strictIds.add(row.id)
    })
    const lexical: RankedCandidate[] = store.searchLexical(query, 200).map((h) => ({ chunkId: h.chunkId, rank: h.rank, documentId: h.documentId, strict: strictIds.has(h.chunkId) }))
    const q = trigramVector(query)
    const semantic: RankedCandidate[] = [...chunkText.entries()]
      .map(([id, text]) => ({ id, score: dotp(q, trigramVector(text)) }))
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, 100)
      .map((s, i) => ({ chunkId: s.id, rank: i + 1, documentId: s.id }))
    for (const c of lexical) if (!semantic.some((s) => s.chunkId === c.chunkId)) void c
    const fused = fuseHybridResultIds(lexical, semantic, { limit: 10, maxChunksPerDocument: 2, ...(gated ? { query: { text: query } } : {}) })
    const position = fused.indexOf(chunkOf.get(targetText)!)
    return position < 0 ? Number.POSITIVE_INFINITY : position + 1
  }

  const invoice = (i: number) => [...chunkText.values()].find((t) => t.includes(`HD-2024-${String(871 + i * 6).padStart(5, '0')}`))!

  it('finds a bare document code, an unseparated amount and a diacritic-less name at rank 1 with the gate', () => {
    const cases: Array<[string, string]> = [
      ['HD-2024-00961', invoice(15)],
      ['HD-2024-01087', invoice(36)],
      ['16.988.880', invoice(15)],
      ['16988880', invoice(15)],
      ['nguyen van an', [...chunkText.values()].find((t) => t.includes('Nguyễn Văn An'))!],
      ['le quoc cuong', [...chunkText.values()].find((t) => t.includes('Lê Quốc Cường'))!],
      ['pham minh duc', [...chunkText.values()].find((t) => t.includes('Phạm Minh Đức'))!],
    ]
    for (const [query, target] of cases) {
      expect(target, query).toBeTruthy()
      expect(rank(query, target, true), `${query} (gated)`).toBe(1)
    }
  })

  it('never ranks an exact-token target lower than the plain 2:1 fusion does', () => {
    const queries: Array<[string, string]> = []
    for (const i of [2, 9, 15, 22, 31, 38]) queries.push([`HD-2024-${String(871 + i * 6).padStart(5, '0')}`, invoice(i)])
    for (const n of NAMES) queries.push([n.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase(), [...chunkText.values()].find((t) => t.includes(n))!])
    let plainFirst = 0
    let gatedFirst = 0
    for (const [query, target] of queries) {
      const plain = rank(query, target, false)
      const gated = rank(query, target, true)
      expect(gated, query).toBeLessThanOrEqual(plain)
      if (plain === 1) plainFirst++
      if (gated === 1) gatedFirst++
    }
    expect(gatedFirst).toBe(queries.length)
    // the problem the gate solves is real on this data: plain 2:1 RRF loses some of them
    expect(plainFirst).toBeLessThan(queries.length)
  })
})
