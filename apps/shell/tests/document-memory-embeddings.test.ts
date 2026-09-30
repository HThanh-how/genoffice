import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import {
  embedTexts,
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
} from '../src/main/document-memory/embeddings'
import { extractDocument } from '../src/main/document-memory/worker'

it('extracts all contents, hashes source and detects empty content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-extract-'))
  try {
    const file = join(dir, 'Bao cao thang 9.txt')
    const content =
      'Lớp 2/1\nHọc sinh Nguyễn An\tĐiện thoại 0901234567\n' +
      'Nội dung khác. '.repeat(1000) +
      'Nội dung cuối cùng.'
    writeFileSync(file, content)
    const result = await extractDocument(file)
    expect(result.chunks[0]!.text).toContain('0901234567')
    expect(result.chunks.at(-1)!.text).toContain('Nội dung cuối cùng.')
    expect(result.hash).toHaveLength(64)
    writeFileSync(file, '')
    expect((await extractDocument(file)).status).toBe('empty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Opt in to the actual pinned 118 MB model; regular CI never depends on model hosting.
const cache =
  process.env.GENOFFICE_EMBEDDING_TEST_CACHE ??
  join(homedir(), 'Library/Application Support/GenOffice/document-memory-models')
it.skipIf(
  !process.env.GENOFFICE_EMBEDDING_TEST_CACHE ||
    !existsSync(join(cache, EMBEDDING_MODEL, EMBEDDING_REVISION, 'onnx/model_quantized.onnx')),
)(
  'real Vietnamese semantic retrieval ranks contact contents above unrelated documents',
  async () => {
    const [query] = await embedTexts(
      ['tìm danh sách số điện thoại học sinh lớp 2/1'],
      'query',
      cache,
    )
    const vectors = await embedTexts(
      [
        'Lớp 2/1. Học sinh Nguyễn An. Điện thoại phụ huynh: 0901234567.',
        'Báo cáo doanh thu quý ba và chi phí vận chuyển công ty.',
        'Bài tập toán lớp 5 về phân số và diện tích hình tam giác.',
      ],
      'passage',
      cache,
    )
    const scores = vectors.map((v) => v.reduce((sum, value, i) => sum + value * query![i]!, 0))
    expect(query).toHaveLength(384)
    expect(scores[0]).toBeGreaterThan(scores[1]!)
    expect(scores[0]).toBeGreaterThan(scores[2]!)
  },
  60_000,
)
