/**
 * The main process is the last stop before the filesystem. A recipient value can
 * make the name longer than the 200-character ceiling, and slicing the whole name
 * can cut off `.docx` / `.pdf`. The extension is preserved, the base is fitted to
 * the remaining budget, and a collision created by shortening is renamed rather
 * than silently destroying another recipient's file.
 */
import { describe, expect, it } from 'vitest'
import { buildOutputFileName } from '@genoffice/docx-engine'
import {
  MAX_NAME_BYTES,
  resolveSafeFileName,
  safeOutputFileName,
  uniqueSafeFileName,
} from '../src/shared/mail-merge-names'

const fits = (name: string): boolean => Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES

describe('final file names', () => {
  it('keeps the extension when the name is longer than the limit', () => {
    const long = 'a'.repeat(300)
    const name = safeOutputFileName(`${long}.docx`)
    expect(name.endsWith('.docx')).toBe(true)
    expect(fits(name)).toBe(true)
  })

  it('keeps .pdf too', () => {
    const name = safeOutputFileName(`${'b'.repeat(400)}.pdf`)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(fits(name)).toBe(true)
  })

  it('handles long Vietnamese names by bytes, not characters', () => {
    const name = safeOutputFileName(`${'Nguyễn Văn '.repeat(30)}.docx`)
    expect(name.endsWith('.docx')).toBe(true)
    expect(fits(name)).toBe(true)
  })

  it('sanitizes unsafe characters and never escapes the directory', () => {
    expect(safeOutputFileName('../../etc/passwd.docx')).toBe('_.._etc_passwd.docx')
    expect(safeOutputFileName('a/b\\c:d?.docx')).toBe('a_b_c_d_.docx')
    expect(safeOutputFileName('...docx')).toBe('merge.docx')
    expect(safeOutputFileName('')).toBe('merge')
  })

  it('does not write a reserved device name', () => {
    expect(safeOutputFileName('CON.docx')).toBe('_CON.docx')
    expect(safeOutputFileName('nul.pdf')).toBe('_nul.pdf')
    expect(safeOutputFileName('LPT9.docx')).toBe('_LPT9.docx')
  })

  it('resolves a collision after shortening with a unique suffix', () => {
    const taken = new Set(['long.docx'])
    expect(uniqueSafeFileName('long.docx', (n) => taken.has(n))).toBe('long (2).docx')
    taken.add('long (2).docx')
    expect(uniqueSafeFileName('long.docx', (n) => taken.has(n))).toBe('long (3).docx')
  })

  it('keeps a suffix inside the byte limit instead of pushing the name over it', () => {
    const atLimit = 'a'.repeat(MAX_NAME_BYTES - 5)
    const name = uniqueSafeFileName(`${atLimit}.docx`, (n) => n === `${atLimit}.docx`)
    expect(fits(name)).toBe(true)
    expect(name.endsWith('.docx')).toBe(true)
    expect(name).not.toBe(`${atLimit}.docx`)
  })
})

describe("the writer's decision", () => {
  it('skips a file that already exists when the user chose skip', () => {
    const files = new Set(['Huy.docx'])
    expect(resolveSafeFileName('Huy.docx', 'skip', (n) => files.has(n))).toEqual({
      name: 'Huy.docx',
      skipped: true,
    })
  })

  it('renames around a file that already exists when the user chose rename', () => {
    const files = new Set(['Huy.docx', 'Huy (2).docx'])
    expect(resolveSafeFileName('Huy.docx', 'rename', (n) => files.has(n))).toEqual({
      name: 'Huy (3).docx',
      skipped: false,
    })
  })

  it('replaces a pre-existing file when the user chose overwrite', () => {
    const files = new Set(['Huy.docx'])
    expect(resolveSafeFileName('Huy.docx', 'overwrite', (n) => files.has(n))).toEqual({
      name: 'Huy.docx',
      skipped: false,
    })
  })

  it('two recipients whose long names shorten to the same name still get two files', () => {
    // the two names differ only past the 200-byte ceiling, so the writer sees one
    // destination for two recipients — the second must be moved aside, not written
    // over the first
    const first = `${'x'.repeat(195)}-first.docx`
    const second = `${'x'.repeat(195)}-second.docx`
    const written = new Set<string>()
    const allocated = new Set<string>()
    const a = resolveSafeFileName(first, 'overwrite', (n) => written.has(n), allocated)
    written.add(a.name)
    allocated.add(a.name)
    const b = resolveSafeFileName(second, 'overwrite', (n) => written.has(n), allocated)
    written.add(b.name)
    // shortening makes the two names identical — the point is that the second
    // write is moved aside instead of destroying the first
    expect(a.name).toBe(safeOutputFileName(second))
    expect(b.name).not.toBe(a.name)
    expect(b.name.endsWith('.docx')).toBe(true)
    expect(fits(b.name)).toBe(true)
    expect(written.size).toBe(2)
  })

  it('never writes a name that is not inside the byte limit', () => {
    const decision = resolveSafeFileName(`${'y'.repeat(500)}.pdf`, 'rename', () => true)
    expect(fits(decision.name)).toBe(true)
    expect(decision.name.endsWith('.pdf')).toBe(true)
  })
})

describe('names the renderer builds', () => {
  it('fits two long recipient columns into one legal name', () => {
    const name = buildOutputFileName({
      pattern: '{First}_{Last}',
      index: 1,
      total: 2,
      values: { First: 'a'.repeat(150), Last: 'b'.repeat(150) },
      extension: 'docx',
    })
    expect(name.endsWith('.docx')).toBe(true)
    expect(fits(name)).toBe(true)
  })

  it('produces a pdf name that still ends in .pdf', () => {
    const name = buildOutputFileName({
      pattern: '{Name}',
      index: 1,
      total: 1,
      values: { Name: 'Nguyễn Văn '.repeat(40) },
      extension: 'pdf',
    })
    expect(name.endsWith('.pdf')).toBe(true)
    expect(fits(name)).toBe(true)
  })
})
