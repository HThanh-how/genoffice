import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractDocument } from '../src/main/document-memory/worker'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-extract-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('extractDocument cost control', () => {
  it('samples a large numeric CSV, flags truncation and skips embeddings', async () => {
    const path = join(dir, 'sensor.csv')
    const rows = Array.from({ length: 60_000 }, (_, i) => `${i},${i * 2.5},${i % 11}`)
    writeFileSync(path, ['t,value,bucket', ...rows].join('\n'))
    const result = await extractDocument(path)
    expect(result.chunks.length).toBeLessThanOrEqual(120)
    expect(result.truncated).toBe(true)
    expect(result.skipEmbeddings).toBe(true)
    expect(result.status).toBe('text-only')
  })

  it('keeps a text CSV searchable and embeddable', async () => {
    const path = join(dir, 'people.csv')
    writeFileSync(path, 'name,city\nAn,Hanoi\nBinh,Hue\nChi,Da Nang')
    const result = await extractDocument(path)
    expect(result.skipEmbeddings).toBeUndefined()
    expect(result.truncated).toBeUndefined()
    expect(result.chunks[0]!.text).toContain('Hanoi')
  })

  it('indexes a very long text document in full', async () => {
    const path = join(dir, 'long.txt')
    writeFileSync(
      path,
      Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} ${'word '.repeat(90)}`).join('\n\n'),
    )
    const result = await extractDocument(path)
    expect(result.chunks.length).toBeGreaterThan(400)
    expect(result.truncated).toBeFalsy()
  })
})
