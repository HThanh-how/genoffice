// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessage, type ChatItem } from '../src/renderer/src/home-chat/ChatMessage'
import { FileRefTable } from '../src/renderer/src/home-chat/file-refs'
import { chatLabels } from './helpers/chat-labels'

const A = 'Chungtu_chitien-LAN2018-61_2025.docx'
const B = 'Chungtu_chitien-LAN2018-61 (1).docx'
const C = 'Chungtu_chitien-LAN2018-53-LONGTRACH - HUNGTAN_2025.docx'

const table = () => {
  const t = new FileRefTable()
  t.addHit({
    documentId: 11,
    chunkId: 1,
    path: `C:\\VNPT\\${A}`,
    name: A,
    text: '',
    location: 'Chunk 5',
    score: 1,
  })
  t.addHit({
    documentId: 12,
    chunkId: 2,
    path: `C:\\VNPT\\${B}`,
    name: B,
    text: '',
    location: 'Chunk 5',
    score: 1,
  })
  t.addFile({ path: `C:\\VNPT\\${C}`, name: C, mtimeMs: Date.UTC(2025, 5, 1) })
  return t
}

let container: HTMLDivElement
let root: Root
const handlers = () => ({ onOpenSource: vi.fn(), onRevealSource: vi.fn(), onRetry: vi.fn() })

async function show(item: Partial<ChatItem>, h = handlers(), lang: 'en' | 'vi' = 'en') {
  await act(async () =>
    root.render(
      createElement(ChatMessage, {
        item: { id: 1, role: 'assistant', text: '', ...item },
        canRetry: false,
        labels: chatLabels(lang),
        ...h,
      }),
    ),
  )
  return h
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('inline file chips', () => {
  const sources = table().list()
  const text = `1. ${A} [[file:1]] & \`${B}\` — hợp đồng 289/HĐT\n2. **${C}** [[file:3]] — phụ lục (Chunk 13)`

  it('draws every named file as a chip at its place in the text, once, with its reason after it', async () => {
    await show({ text, sources })
    const chips = [...container.querySelectorAll('.hc-answer .hc-file')]
    expect(chips.map((c) => c.querySelector('.hc-file-name')?.textContent)).toEqual([A, B, C])
    // the file name appears once per mention: as the chip, not again as plain text
    expect(container.querySelector('.hc-answer')!.textContent!.split(A)).toHaveLength(2)
    expect(container.querySelector('.hc-answer')!.textContent).not.toContain('[[file')
    expect(container.querySelector('.hc-answer')!.textContent).not.toContain('genoffice-file')
    expect(container.querySelectorAll('.hc-file-note').length).toBe(2)
    expect(container.querySelector('.hc-file-note')!.textContent).toContain('hợp đồng 289')
  })

  it('opens the right file when its chip is clicked', async () => {
    const h = await show({ text, sources })
    const chips = container.querySelectorAll<HTMLButtonElement>('.hc-answer .hc-file-open')
    await act(async () => chips[1]!.click())
    expect(h.onOpenSource).toHaveBeenCalledTimes(1)
    expect(h.onOpenSource.mock.calls[0]![0]).toMatchObject({ documentId: 12, name: B })
    await act(async () => chips[2]!.click())
    expect(h.onOpenSource.mock.calls[1]![0]).toMatchObject({
      documentId: 0,
      path: `C:\\VNPT\\${C}`,
    })
  })

  it('has an actions menu: show in folder, copy path', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const h = await show({ text, sources })
    const more = container.querySelector<HTMLButtonElement>('.hc-answer .hc-file-more')!
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await act(async () => more.click())
    const items = [
      ...container.querySelectorAll<HTMLButtonElement>('.hc-file-menu [role="menuitem"]'),
    ]
    expect(items.map((i) => i.textContent)).toEqual(['Open', 'Show in folder', 'Copy path'])
    await act(async () => items[1]!.click())
    expect(h.onRevealSource.mock.calls[0]![0]).toMatchObject({ name: A })
    expect(container.querySelector('.hc-file-menu')).toBeNull()
    await act(async () => more.click())
    await act(async () =>
      container.querySelectorAll<HTMLButtonElement>('.hc-file-menu [role="menuitem"]')[2]!.click(),
    )
    expect(writeText).toHaveBeenCalledWith(`C:\\VNPT\\${A}`)
  })

  it('closes the menu on Escape and on a press outside', async () => {
    await show({ text, sources })
    const more = container.querySelector<HTMLButtonElement>('.hc-answer .hc-file-more')!
    await act(async () => more.click())
    expect(container.querySelector('.hc-file-menu')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.hc-file-menu')).toBeNull()
    await act(async () => more.click())
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('.hc-file-menu')).toBeNull()
  })

  it('does not link ids or paths that are not among this message sources', async () => {
    await show({
      text: `x [[file:9]] y [fake](genoffice-file:2) z ${B}`,
      sources: [table().list()[0]!],
    })
    expect(container.querySelectorAll('.hc-file')).toHaveLength(0)
    expect(container.querySelector('.hc-answer')!.textContent).not.toContain('[[file')
  })

  it('names carry the missing and stale state without being clickable when the file is gone', async () => {
    await show({
      text: `${A} [[file:1]]`,
      sources: [{ ...table().list()[0]!, missing: true }],
    })
    expect(container.querySelector<HTMLButtonElement>('.hc-file-open')!.disabled).toBe(true)
    expect(container.querySelector('.hc-file.missing')).not.toBeNull()
  })
})

describe('streaming', () => {
  const candidates = table().list()

  it('links complete markers from the candidates and hides a half-written one, without cards', async () => {
    await show({ streaming: true, text: `Có ${A} [[file:1]] và ${B} [[fi`, candidates })
    expect(container.querySelectorAll('.hc-file')).toHaveLength(1)
    expect(container.querySelector('.hc-answer')!.textContent).not.toContain('[[')
    expect(container.querySelector('.hc-files')).toBeNull()
    // the next token completes it: the second name is still plain text, no chip yet
    await show({ streaming: true, text: `Có ${A} [[file:1]] và ${B} [[file:2]]`, candidates })
    expect(container.querySelectorAll('.hc-file')).toHaveLength(2)
  })

  it('does not link plain names until the answer is complete', async () => {
    await show({ streaming: true, text: `Có ${A}`, candidates })
    expect(container.querySelectorAll('.hc-file')).toHaveLength(0)
    await show({ streaming: false, text: `Có ${A}`, sources: candidates })
    expect(container.querySelectorAll('.hc-file')).toHaveLength(1)
  })
})

describe('file cards', () => {
  it('lists only the given (cited) files, with folder, date and an Open button', async () => {
    const sources = table().list()
    const h = await show({ text: 'ok', sources: [sources[2]!, sources[0]!] })
    const cards = [...container.querySelectorAll('.hc-card')]
    expect(cards.map((c) => c.querySelector('.hc-card-name')?.textContent)).toEqual([C, A])
    expect(container.querySelector('.hc-files-title')?.textContent).toBe('Files in this answer · 2')
    const meta = [...cards[0]!.querySelectorAll('.hc-card-meta')]
      .map((m) => m.textContent)
      .join(' | ')
    expect(meta).toContain('C:\\VNPT')
    expect(meta).toContain('2025')
    await act(async () => cards[1]!.querySelector<HTMLButtonElement>('.hc-card-open')!.click())
    expect(h.onOpenSource.mock.calls[0]![0]).toMatchObject({ name: A })
  })

  it('titles files nobody cited as related', async () => {
    const sources = table()
      .list()
      .map((s) => ({ ...s, related: true }))
    await show({ text: 'Không có.', sources })
    expect(container.querySelector('.hc-files-title')?.textContent).toBe('Related files · 3')
  })

  it('folds index details away: closed by default, and absent from the answer and cards', async () => {
    const sources = [{ ...table().list()[0]!, stale: true }, table().list()[1]!]
    await show({ text: `${A} [[file:1]]`, sources })
    const details = container.querySelector<HTMLDetailsElement>('.hc-details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toBe('Search details')
    expect(details.textContent).toContain('Chunk 5')
    expect(container.querySelector('.hc-answer')!.textContent).not.toMatch(/Chunk|status/i)
    // a changed file still shows a badge on its card, where it affects opening
    expect(container.querySelector('.hc-card .hc-source-flag')!.textContent).toBe('Changed')
  })

  it('shows no cards while streaming and none when there are no sources', async () => {
    await show({ text: 'chào', streaming: true, sources: table().list() })
    expect(container.querySelector('.hc-files')).toBeNull()
    await show({ text: 'chào' })
    expect(container.querySelector('.hc-files')).toBeNull()
  })

  it('copies the answer with file names instead of markers', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await show({ text: `Mở [[file:1]] nhé`, sources: table().list() })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.hc-msg-actions button')!.click(),
    )
    expect(writeText).toHaveBeenCalledWith(`Mở ${A} nhé`)
  })
})
