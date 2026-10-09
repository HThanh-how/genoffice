import { describe, expect, it, vi } from 'vitest'
import type { DocumentMemoryHit } from '@genoffice/agent-core'
import {
  FILE_CITATION_RULES_CONTEXT,
  FILE_CITATION_RULES_TOOLS,
  FILE_LINK_SCHEME,
  FileRefTable,
  hidePartialMarker,
  linkAnswer,
  pickSources,
  plainAnswer,
  refBridge,
  withRefs,
} from '../src/renderer/src/home-chat/file-refs'
import {
  agySystemSuffix,
  buildRetrievalContext,
  namedFilesBlock,
} from '../src/renderer/src/home-chat/agy-retrieval'
import { toSeedMessages } from '../src/renderer/src/home-chat/utils'

const A = 'Chungtu_chitien-LAN2018-61_2025.docx'
const B = 'Chungtu_chitien-LAN2018-61 (1).docx'
const C = 'Chungtu_chitien-LAN2018-53-LONGTRACH - HUNGTAN_2025.docx'

const hit = (id: number, name: string, chunkId: number, location: string): DocumentMemoryHit => ({
  documentId: id,
  chunkId,
  path: `C:\\VNPT\\${name}`,
  name,
  text: `Hợp đồng thuê vị trí ${id} ${location}`,
  location,
  score: 1,
})

/** The three files of the report, hits as the index returns them (two passages for the first). */
const vnptHits = [
  hit(11, A, 101, 'Chunk 5'),
  hit(11, A, 102, 'Chunk 12'),
  hit(12, B, 103, 'Chunk 5'),
  hit(13, C, 104, 'Chunk 13'),
]

const tableOf = () => {
  const context = buildRetrievalContext(vnptHits)
  return context.table
}

describe('FileRefTable', () => {
  it('gives each file one id however many passages match, and keeps order', () => {
    const table = tableOf()
    expect(table.list().map((s) => [s.ref, s.name])).toEqual([
      [1, A],
      [2, B],
      [3, C],
    ])
    expect(table.get(1)?.location).toBe('Chunk 5 · Chunk 12')
    expect(table.get(1)?.path).toBe(`C:\\VNPT\\${A}`)
  })

  it('merges a file found by name into the hit with the same path (slashes and case ignored)', () => {
    const table = tableOf()
    const again = table.addFile({ path: `c:/vnpt/${A.toUpperCase()}`, name: A })
    expect(again.ref).toBe(1)
    expect(table.size).toBe(3)
    expect(table.addFile({ path: 'D:\\x\\other.pdf', name: 'other.pdf' }).ref).toBe(4)
  })

  it('carries stale / missing / outline flags onto the file', () => {
    const table = new FileRefTable()
    table.addHit(hit(1, 'a.docx', 1, 'p1'))
    table.addHit({ ...hit(1, 'a.docx', 2, 'p2'), stale: true })
    table.addHit({ ...hit(2, 'b.docx', 3, 'p1'), missing: true, skeletonIndex: true })
    expect(table.get(1)?.stale).toBe(true)
    expect(table.get(2)).toMatchObject({ missing: true, skeletonIndex: true })
  })
})

describe('model-facing context', () => {
  it('numbers FILES (not passages), continues the numbers for files found by name', () => {
    const context = buildRetrievalContext(vnptHits)
    expect(context.block).toContain(`[1] file: ${A} | location: Chunk 5 | status: OK`)
    expect(context.block).toContain('  also at: Chunk 12')
    expect(context.block).toContain(`[2] file: ${B}`)
    expect(context.block).toContain(`[3] file: ${C}`)
    expect(context.block).not.toContain('[4]')
    const named = namedFilesBlock(
      [
        { path: `C:\\VNPT\\${A}`, name: A }, // already a hit: not listed twice
        { path: 'C:\\VNPT\\Phu luc.pdf', name: 'Phu luc.pdf' },
      ],
      context.table,
    )
    expect(named.block).toContain('[4] file: Phu luc.pdf | path: C:\\VNPT\\Phu luc.pdf')
    expect(named.block).not.toContain(`file: ${A}`)
    expect(context.table.get(4)?.documentId).toBe(0)
  })

  it('tells the model to cite by id and not to print chunk / status internals (contract)', () => {
    const context = buildRetrievalContext(vnptHits)
    const prompt = agySystemSuffix('Vietnamese', context)
    expect(prompt).toContain('[[file:ID]]')
    expect(prompt).toContain('number in square brackets')
    expect(prompt).toContain('Chunk 5')
    expect(prompt).toMatch(/Mention each relevant file once, with a one-line reason/)
    expect(prompt).toMatch(/no status words/)
    expect(prompt).toContain('[1] file:')
    expect(FILE_CITATION_RULES_TOOLS).toContain('`ref`')
    expect(FILE_CITATION_RULES_TOOLS).toContain('[[file:ID]]')
    expect(FILE_CITATION_RULES_CONTEXT).not.toContain('`ref`')
  })

  it('numbers tool results the same way: every search hit and read result carries its ref', async () => {
    const table = new FileRefTable()
    const bridge = refBridge(
      {
        documentMemorySearch: vi.fn(async () => ({
          hits: [...vnptHits, { ...hit(0, 'x.pdf', 0, 'file name'), documentId: 0 }],
          pending: 0,
          errors: 0,
          modelState: 'ready',
        })),
        documentMemoryRead: vi.fn(async () => ({
          path: `C:\\VNPT\\${B}`,
          name: B,
          location: 'Chunk 5',
          text: 't',
          verified: true,
        })),
        documentMemoryOpen: vi.fn(async () => ({ ok: true })),
      },
      () => table,
    )
    const found = await bridge.documentMemorySearch!('vnpt', 8)
    expect(found.hits.map((h) => (h as { ref?: number }).ref)).toEqual([1, 1, 2, 3, 4])
    const read = await bridge.documentMemoryRead!(103)
    expect((read as { ref?: number }).ref).toBe(2)
    // a second search in the same conversation keeps the ids
    const again = await bridge.documentMemorySearch!('vnpt', 8)
    expect((again.hits[0] as { ref?: number }).ref).toBe(1)
    expect(table.size).toBe(4)
  })
})

describe('linkAnswer: markers', () => {
  const sources = tableOf().list()
  const token = (n: number) => `[file](${FILE_LINK_SCHEME}${n})`

  it('turns the marker after a file name into one chip, not name + chip', () => {
    const out = linkAnswer(
      `1. ${A} [[file:1]] — hợp đồng 289\n2. \`${C}\` [[file:3]] — phụ lục`,
      sources,
    )
    expect(out.markdown).toBe(
      `1. ${token(1)} [— hợp đồng 289](${FILE_LINK_SCHEME}note)\n2. ${token(3)} [— phụ lục](${FILE_LINK_SCHEME}note)`,
    )
    expect(out.cited).toEqual([1, 3])
  })

  it('reads the lenient spellings and several ids at once', () => {
    expect(linkAnswer('a [[file: 2]] b [file:3] c [[1]] d [[file:1, 3]]', sources).cited).toEqual([
      2, 3, 1,
    ])
    expect(linkAnswer('x [[File:2]]', sources).cited).toEqual([2])
    expect(linkAnswer('x [2] y', sources).cited).toEqual([2])
  })

  it('drops unknown ids and never touches markdown links or other numbers', () => {
    const out = linkAnswer('see [[file:9]] and [docs](https://x.y) [3](u) in [2025]', sources)
    expect(out.cited).toEqual([])
    expect(out.markdown).toBe('see and [docs](https://x.y) [3](u) in [2025]')
  })

  it('hides a half-written marker while streaming, so it never flashes', () => {
    for (const partial of ['[', '[[', '[[fi', '[[file', '[[file:', '[[file:3', '[[file:3]'])
      expect(hidePartialMarker(`Hợp đồng ${partial}`)).toBe('Hợp đồng')
    expect(hidePartialMarker('Giá [1] triệu')).toBe('Giá [1] triệu')
    const streamed = linkAnswer(`${A} [[file:1]] và ${B} [[file:`, sources, { streaming: true })
    expect(streamed.cited).toEqual([1])
    expect(streamed.markdown).not.toContain('[[file')
  })

  it('while streaming only markers are linked, plain names stay text until the answer ends', () => {
    expect(linkAnswer(`đọc ${A}`, sources, { streaming: true }).markdown).toBe(`đọc ${A}`)
    expect(linkAnswer(`đọc ${A}`, sources).markdown).toBe(`đọc ${token(1)}`)
  })
})

describe('linkAnswer: names without a marker', () => {
  const sources = tableOf().list()
  const token = (n: number) => `[file](${FILE_LINK_SCHEME}${n})`

  it('links the exact names of the report, with spaces, parentheses, ampersands and dashes', () => {
    const answer = [
      `1. \`${A}\` & \`${B}\` — Chunk 5, Chunk 12 (status OK)`,
      `2. **${C}** — Chunk 13`,
    ].join('\n')
    const out = linkAnswer(answer, sources)
    expect(out.cited).toEqual([1, 2, 3])
    expect(out.markdown).toContain(`1. ${token(1)} & ${token(2)}`)
    expect(out.markdown).toContain(`2. ${token(3)}`)
    expect(out.markdown).not.toContain('`')
    expect(out.markdown).not.toContain('**')
  })

  it('prefers the longer name ("… (1).docx") over the shorter one it does not contain', () => {
    const table = new FileRefTable()
    table.addFile({ path: '/d/Report.docx', name: 'Report.docx' })
    table.addFile({ path: '/d/Report (1).docx', name: 'Report (1).docx' })
    const out = linkAnswer('Report (1).docx và Report.docx', table.list())
    expect(out.cited).toEqual([2, 1])
  })

  it('matches case-insensitively and across Unicode forms, but only at word edges', () => {
    const table = new FileRefTable()
    table.addFile({ path: '/d/Hợp đồng VNPT.DOCX', name: 'Hợp đồng VNPT.DOCX' })
    const decomposed = 'hợp đồng vnpt.docx'.normalize('NFD')
    expect(linkAnswer(`mở ${decomposed} đi`, table.list()).cited).toEqual([1])
    expect(linkAnswer('xHợp đồng VNPT.DOCXy', table.list()).cited).toEqual([])
  })

  it('leaves names inside inline code or fenced code alone', () => {
    const out = linkAnswer(`run \`open ${A} now\`\n\`\`\`\n${B}\n\`\`\``, sources)
    expect(out.cited).toEqual([])
  })

  it('never links a file that is not in the table', () => {
    expect(linkAnswer('đọc Bao cao la.docx và [[file:7]]', sources).cited).toEqual([])
  })
})

describe('pickSources', () => {
  const sources = tableOf().list()

  it('offers only the cited files, in the order they are cited', () => {
    const picked = pickSources(`${C} [[file:3]], ${A} [[file:1]]`, sources)
    expect(picked.sources.map((s) => s.name)).toEqual([C, A])
    expect(picked.related).toBe(false)
    expect(picked.sources.every((s) => !s.related)).toBe(true)
  })

  it('keeps at most eight', () => {
    const table = new FileRefTable()
    for (let i = 1; i <= 12; i++) table.addFile({ path: `/d/f${i}.pdf`, name: `f${i}.pdf` })
    const text = Array.from({ length: 12 }, (_, i) => `[[file:${i + 1}]]`).join(' ')
    expect(pickSources(text, table.list()).sources).toHaveLength(8)
  })

  it('falls back to the retrieved files, flagged related, only when nothing is cited', () => {
    const picked = pickSources('Không tìm thấy hợp đồng nào.', sources)
    expect(picked.related).toBe(true)
    expect(picked.sources.map((s) => s.ref)).toEqual([1, 2, 3])
    expect(picked.sources.every((s) => s.related)).toBe(true)
    expect(pickSources('Không tìm thấy.', sources, { fallback: false }).sources).toEqual([])
    expect(pickSources('', sources).sources).toEqual([])
  })

  it('limits the fallback to the pool of this turn', () => {
    const picked = pickSources('nothing', sources, { pool: sources.slice(2) })
    expect(picked.sources.map((s) => s.ref)).toEqual([3])
  })
})

describe('plain text and history', () => {
  const sources = tableOf().list()

  it('replaces markers by the file name only when the name was not written', () => {
    expect(plainAnswer(`đọc ${A} [[file:1]] rồi [[file:2]].`, sources)).toBe(`đọc ${A} rồi ${B}.`)
  })

  it('does not feed old ids back to the model as history', () => {
    const seed = toSeedMessages([
      { role: 'user', text: 'tìm hợp đồng' },
      { role: 'assistant', text: `Có ${A} [[file:1]].`, sources },
      { role: 'user', text: 'còn nữa?' },
      { role: 'assistant', text: 'ok' },
    ])
    expect(seed[1]).toEqual({ role: 'assistant', text: `Có ${A}.` })
  })

  it('gives sources saved before ids existed an id above the marker range', () => {
    const old = [{ documentId: 5, name: 'a.docx', location: '' }]
    expect(withRefs(old)?.[0]?.ref).toBe(1000)
    expect(linkAnswer('mở a.docx', withRefs(old)!).cited).toEqual([1000])
    expect(linkAnswer('lạ [[file:1000]]', withRefs(old)!).cited).toEqual([])
  })
})
