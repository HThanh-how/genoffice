import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIPBOARD_HISTORY_MAX_ENTRIES,
  CLIPBOARD_HISTORY_MAX_TOTAL_BYTES,
  ClipboardHistory,
  looksSensitive,
  normalizeClipboardHistory,
} from '../src/main/fork/clipboard-history'

const dirs: string[] = []
function historyPath() {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-clipboard-history-'))
  dirs.push(dir)
  return join(dir, 'history.json')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('ClipboardHistory', () => {
  it('does not read or retain clipboard text while disabled or unfocused', () => {
    let text = 'private text that predates focus'
    let enabled = false
    let reads = 0
    const history = new ClipboardHistory(
      {
        isExcluded: () => false,
        readText: () => {
          reads++
          return text
        },
      },
      () => enabled,
      historyPath,
    )
    history.setFocused(true)
    expect(reads).toBe(0)
    enabled = true
    history.settingsChanged()
    expect(reads).toBe(1)
    expect(history.list()).toEqual([])
    text = 'copied after enabling history'
    history.check()
    expect(history.list().map((entry) => entry.text)).toEqual([text])
    history.setFocused(false)
    text = 'copied while GenOffice was in the background'
    history.check()
    expect(history.list()).toHaveLength(1)
    history.dispose()
  })

  it('skips protected clipboard owners, masks secret-like values and erases data when disabled', () => {
    let excluded = true
    let text = 'normal clipboard text'
    let enabled = true
    const path = historyPath()
    const history = new ClipboardHistory(
      { isExcluded: () => excluded, readText: () => text },
      () => enabled,
      () => path,
    )
    history.setFocused(true)
    expect(history.list()).toEqual([])
    excluded = false
    text = 'sk-proj-123456789012345678901234567890'
    history.check()
    // kept (it still pastes) but flagged so the UI masks it
    expect(history.list().map((e) => [e.text, e.sensitive])).toEqual([[text, true]])
    text = 'ordinary copied text that is safe'
    history.check()
    expect(history.list()).toHaveLength(2)
    expect(history.list()[0]!.sensitive).toBeUndefined()
    // sensitive text is never written to disk
    expect(readFileSync(path, 'utf8')).not.toContain('sk-proj')
    enabled = false
    history.settingsChanged()
    expect(history.list()).toEqual([])
    expect(existsSync(path)).toBe(false)
    history.dispose()
  })

  it('caps the persisted history by count and total UTF-8 bytes and validates stored entries', () => {
    let enabled = true
    let text = 'clip 0'
    const history = new ClipboardHistory(
      { isExcluded: () => false, readText: () => text },
      () => enabled,
      historyPath,
    )
    history.setFocused(true)
    for (let i = 1; i <= CLIPBOARD_HISTORY_MAX_ENTRIES + 4; i++) {
      text = `clip ${i}`
      history.check()
    }
    expect(history.list()).toHaveLength(CLIPBOARD_HISTORY_MAX_ENTRIES)
    expect(history.list()[0].text).toBe(`clip ${CLIPBOARD_HISTORY_MAX_ENTRIES + 4}`)
    expect(
      history.list().reduce((size, entry) => size + Buffer.byteLength(entry.text), 0),
    ).toBeLessThanOrEqual(CLIPBOARD_HISTORY_MAX_TOTAL_BYTES)
    expect(
      normalizeClipboardHistory([
        { id: 'secret', text: 'password=hunter2-long-secret', copiedAt: 1 },
        { id: 'valid', text: 'a safe stored clipboard value', copiedAt: 2 },
      ]),
    ).toEqual([
      {
        id: 'secret',
        kind: 'text',
        text: 'password=hunter2-long-secret',
        copiedAt: 1,
        sensitive: true,
      },
      { id: 'valid', kind: 'text', text: 'a safe stored clipboard value', copiedAt: 2 },
    ])
    enabled = false
    history.settingsChanged()
    history.dispose()
  })

  it('records images when there is no text, never lists their bytes, and can restore them', () => {
    let image: { png: Buffer; preview: string; width: number; height: number } | null = null
    let text = ''
    const history = new ClipboardHistory(
      { isExcluded: () => false, readText: () => text, readImage: () => image },
      () => true,
      historyPath,
    )
    history.setFocused(true)
    const png = Buffer.from('fake-png-bytes')
    image = { png, preview: 'data:image/png;base64,AAAA', width: 10, height: 5 }
    history.check()
    const [entry] = history.list()
    expect(entry).toMatchObject({ kind: 'image', width: 10, height: 5 })
    expect(JSON.stringify(entry)).not.toContain(png.toString('base64'))
    expect(history.imagePng(entry!.id)).toEqual(png)
    // text wins when both are present (spreadsheet cells carry a picture too)
    text = 'cells copied from a sheet'
    history.check()
    expect(history.list()[0]!.kind).toBe('text')
    history.dispose()
  })

  it('treats unusually long unbroken strings as sensitive but leaves urls, paths and prose alone', () => {
    expect(looksSensitive('aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6')).toBe(true)
    expect(looksSensitive('https://example.com/some/really/long/path/with/numbers/12345678')).toBe(
      false,
    )
    expect(looksSensitive('/Users/me/Documents/some very long folder name 2024/report.pdf')).toBe(
      false,
    )
    expect(looksSensitive('a perfectly normal sentence with 3 numbers in it')).toBe(false)
  })
})
