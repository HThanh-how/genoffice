// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { fileKindFor, fileTypeTokens, type FileKind } from '../src/renderer/src/file-icons'
import { FileTypeIcon } from '../src/renderer/src/home-chat/FileTypeIcon'

const CASES: Array<[string, FileKind, string]> = [
  ['a.pdf', 'pdf', 'pdf'],
  ['a.xlsx', 'sheet', 'sheet'],
  ['a.xls', 'sheet', 'sheet'],
  ['a.csv', 'sheet', 'sheet'],
  ['a.docx', 'doc', 'doc'],
  ['a.doc', 'doc', 'doc'],
  ['a.rtf', 'doc', 'doc'],
  ['a.odt', 'doc', 'doc'],
  ['a.pptx', 'slides', 'slides'],
  ['a.ppt', 'slides', 'slides'],
  ['a.png', 'image', 'image'],
  ['a.jpg', 'image', 'image'],
  ['a.webp', 'image', 'image'],
  ['a.mp4', 'video', 'video'],
  ['a.mov', 'video', 'video'],
  ['a.mp3', 'audio', 'audio'],
  ['a.wav', 'audio', 'audio'],
  ['a.txt', 'text', 'text'],
  ['a.md', 'text', 'text'],
  ['a.json', 'text', 'text'],
  ['a.zip', 'archive', 'other'],
  ['a.7z', 'archive', 'other'],
  ['a.xyz', 'other', 'other'],
  ['no-extension', 'other', 'other'],
]

describe('file type colours', () => {
  it.each(CASES)('%s is %s and uses the --file-%s tokens', (name, kind, token) => {
    expect(fileKindFor(name)).toBe(kind)
    expect(fileTypeTokens(name)).toEqual({
      kind,
      fg: `--file-${token}`,
      soft: `--file-${token}-soft`,
    })
  })

  it('ignores case and surrounding dots in the name', () => {
    expect(fileKindFor('HỢP ĐỒNG (1).DOCX')).toBe('doc')
    expect(fileKindFor('Bảng.XLSX')).toBe('sheet')
    expect(fileKindFor('a.b.PdF')).toBe('pdf')
  })

  it('gives every family its own colour pair', () => {
    const pairs = new Set(
      [
        'a.pdf',
        'a.xlsx',
        'a.docx',
        'a.pptx',
        'a.png',
        'a.mp4',
        'a.mp3',
        'a.txt',
        'a.zip',
        'a.xyz',
      ].map((n) => fileTypeTokens(n).fg),
    )
    expect(pairs.size).toBe(9) // archives share the neutral tokens with unknown files
  })

  it('defines each token in all three blocks of tokens.css (light, dark, system-dark fallback)', () => {
    const css = readFileSync(join(process.cwd(), '../../packages/ui/src/tokens.css'), 'utf8')
    for (const token of new Set(CASES.flatMap(([, , t]) => [`--file-${t}`, `--file-${t}-soft`]))) {
      expect(css.split(`${token}:`).length - 1, token).toBe(3)
    }
  })

  it('draws the tile from tokens, never raw colours, and is hidden from assistive tech', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () =>
      createRoot(el).render(createElement(FileTypeIcon, { name: 'Report.PDF' })),
    )
    const tile = el.querySelector<HTMLElement>('.hc-ft')!
    expect(tile.dataset.kind).toBe('pdf')
    expect(tile.dataset.ext).toBe('pdf')
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.style.getPropertyValue('--ft')).toBe('var(--file-pdf)')
    expect(tile.style.getPropertyValue('--ft-soft')).toBe('var(--file-pdf-soft)')
    expect(tile.outerHTML).not.toMatch(/#[0-9a-f]{3,8}|rgb\(/i)
    el.remove()
  })
})
