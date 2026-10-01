import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIPBOARD_HISTORY_MAX_ENTRIES,
  CLIPBOARD_HISTORY_MAX_TOTAL_BYTES,
  ClipboardHistory,
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

  it('skips protected clipboard owners and secret-like values, and erases data when disabled', () => {
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
    expect(history.list()).toEqual([])
    text = 'ordinary copied text that is safe'
    history.check()
    expect(history.list()).toHaveLength(1)
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
    ).toEqual([{ id: 'valid', text: 'a safe stored clipboard value', copiedAt: 2 }])
    enabled = false
    history.settingsChanged()
    history.dispose()
  })
})
