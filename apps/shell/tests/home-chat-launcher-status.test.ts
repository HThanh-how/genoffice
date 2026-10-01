import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ELAPSED_AFTER_S,
  PREVIEW_MS,
  createLauncherController,
  elapsedSeconds,
  finishOf,
  formatElapsed,
  previewText,
  type LauncherState,
} from '../src/renderer/src/home-chat/launcher-status'

describe('previewText', () => {
  it('strips Markdown to one plain line', () => {
    expect(previewText('## Budget\n\nThe **Q3** budget is in [Budget.xlsx](file:///x) now.')).toBe(
      'Budget The Q3 budget is in Budget.xlsx now.',
    )
  })

  it('handles lists, quotes, inline code, images and html', () => {
    expect(previewText('- first\n- second\n\n> quoted `code`\n\n![chart](a.png) <b>bold</b>')).toBe(
      'first second quoted code chart bold',
    )
    expect(previewText('1. one\n2) two\n- [x] done')).toBe('one two done')
  })

  it('keeps code fence contents but not the fences, and drops table scaffolding', () => {
    expect(previewText('```ts\nconst a = 1\n```')).toBe('const a = 1')
    expect(previewText('| Name | Qty |\n| --- | --- |\n| Pen | 3 |')).toBe('Name Qty Pen 3')
  })

  it('leaves snake_case and ordinary punctuation alone', () => {
    expect(previewText('Open my_file_name.docx (draft) *now*')).toBe(
      'Open my_file_name.docx (draft) now',
    )
  })

  it('returns an empty string for empty or markup-only text', () => {
    expect(previewText('')).toBe('')
    expect(previewText('---\n\n***')).toBe('')
  })

  it('ellipsizes at a word boundary within the limit', () => {
    const out = previewText('word '.repeat(40), 70)
    expect(Array.from(out).length).toBeLessThanOrEqual(70)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/wor…$/)
    expect(previewText('short answer')).toBe('short answer')
  })

  it('never splits emoji or CJK code points', () => {
    const out = previewText('😀'.repeat(100), 70)
    expect(Array.from(out)).toHaveLength(70)
    expect(out.endsWith('…')).toBe(true)
    expect(Array.from(previewText('你好，世界。'.repeat(30), 20))).toHaveLength(20)
  })
})

describe('elapsed helpers', () => {
  const secs = (n: number) => `${n}s`
  it('counts whole seconds and never goes negative', () => {
    expect(elapsedSeconds(1000, 6900)).toBe(5)
    expect(elapsedSeconds(5000, 1000)).toBe(0)
  })
  it('shows nothing before the threshold, seconds under a minute, then m:ss', () => {
    expect(formatElapsed(ELAPSED_AFTER_S - 1, secs)).toBeNull()
    expect(formatElapsed(ELAPSED_AFTER_S, secs)).toBe('5s')
    expect(formatElapsed(59, secs)).toBe('59s')
    expect(formatElapsed(60, secs)).toBe('1:00')
    expect(formatElapsed(125, secs)).toBe('2:05')
  })
})

describe('finishOf', () => {
  it('classifies the settled assistant message', () => {
    expect(finishOf({ role: 'assistant', text: 'Hi' }, false)).toEqual({ kind: 'done', text: 'Hi' })
    expect(finishOf({ role: 'assistant', text: 'part', error: 'boom' }, false)).toEqual({
      kind: 'error',
    })
    expect(finishOf({ role: 'assistant', text: '', error: 'Stopped.' }, true)).toEqual({
      kind: 'stopped',
    })
    expect(finishOf({ role: 'assistant', text: 'Hi' }, true)).toEqual({ kind: 'stopped' })
    expect(finishOf({ role: 'user', text: 'Hi' }, false)).toEqual({ kind: 'stopped' })
    expect(finishOf(undefined, false)).toEqual({ kind: 'stopped' })
    expect(finishOf({ role: 'assistant', text: '  ' }, false)).toEqual({ kind: 'stopped' })
  })
})

describe('launcher controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 15, 10, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  const make = () => {
    const seen: LauncherState[] = []
    const ctl = createLauncherController((s) => seen.push(s))
    return { ctl, seen }
  }

  it('starts idle and works while a reply runs', () => {
    const { ctl, seen } = make()
    expect(ctl.getState().phase).toBe('idle')
    ctl.runStarted()
    expect(ctl.getState()).toMatchObject({ phase: 'working', startedAt: Date.now(), unread: false })
    expect(seen).toHaveLength(1)
  })

  it('a reply finishing while minimized shows a preview and unread, then collapses to the pill', () => {
    const { ctl } = make()
    ctl.runStarted()
    ctl.runFinished({ kind: 'done', text: '**Done.** The file is ready.' })
    expect(ctl.getState()).toMatchObject({
      phase: 'done',
      preview: 'Done. The file is ready.',
      unread: 'done',
    })
    vi.advanceTimersByTime(PREVIEW_MS - 1)
    expect(ctl.getState().phase).toBe('done')
    vi.advanceTimersByTime(1)
    // the preview is gone but the unread mark stays until the panel is opened
    expect(ctl.getState()).toMatchObject({ phase: 'idle', preview: '', unread: 'done' })
  })

  it('hover keeps the preview and leaving restarts the countdown', () => {
    const { ctl } = make()
    ctl.runStarted()
    ctl.runFinished({ kind: 'done', text: 'Answer' })
    vi.advanceTimersByTime(PREVIEW_MS - 100)
    ctl.setHovered(true)
    vi.advanceTimersByTime(PREVIEW_MS * 3)
    expect(ctl.getState().phase).toBe('done')
    ctl.setHovered(false)
    vi.advanceTimersByTime(PREVIEW_MS - 1)
    expect(ctl.getState().phase).toBe('done')
    vi.advanceTimersByTime(1)
    expect(ctl.getState().phase).toBe('idle')
  })

  it('finishing while hovered waits for the pointer to leave', () => {
    const { ctl } = make()
    ctl.setHovered(true)
    ctl.runStarted()
    ctl.runFinished({ kind: 'done', text: 'Answer' })
    vi.advanceTimersByTime(PREVIEW_MS * 2)
    expect(ctl.getState().phase).toBe('done')
  })

  it('an error while minimized stays visible until the panel opens', () => {
    const { ctl } = make()
    ctl.runStarted()
    ctl.runFinished({ kind: 'error' })
    expect(ctl.getState()).toMatchObject({ phase: 'error', unread: 'error' })
    vi.advanceTimersByTime(PREVIEW_MS * 5)
    expect(ctl.getState().phase).toBe('error')
    ctl.setPanelOpen(true)
    expect(ctl.getState()).toMatchObject({ phase: 'idle', unread: false })
  })

  it('opening the panel clears unread and the preview', () => {
    const { ctl } = make()
    ctl.runStarted()
    ctl.runFinished({ kind: 'done', text: 'Answer' })
    ctl.setPanelOpen(true)
    expect(ctl.getState()).toMatchObject({ phase: 'idle', preview: '', unread: false })
    vi.advanceTimersByTime(PREVIEW_MS * 2) // the stale timer must not resurrect anything
    expect(ctl.getState().phase).toBe('idle')
  })

  it('opening the panel mid-reply keeps it working but never marks it unread', () => {
    const { ctl } = make()
    ctl.runStarted()
    ctl.setPanelOpen(true)
    expect(ctl.getState().phase).toBe('working')
    ctl.runFinished({ kind: 'done', text: 'Answer' })
    expect(ctl.getState()).toMatchObject({ phase: 'idle', unread: false })
  })

  it('minimize mid-reply then finish: unread; focus regained while open acknowledges', () => {
    const { ctl } = make()
    ctl.setPanelOpen(true)
    ctl.runStarted()
    ctl.setPanelOpen(false)
    expect(ctl.getState().phase).toBe('working')
    ctl.runFinished({ kind: 'done', text: 'Answer' })
    expect(ctl.getState().unread).toBe('done')
    ctl.setPanelOpen(true)
    ctl.acknowledge()
    expect(ctl.getState().unread).toBe(false)
  })

  it('a stopped run leaves nothing unread and clears a pending preview timer', () => {
    const { ctl } = make()
    ctl.runStarted()
    ctl.runFinished({ kind: 'done', text: 'First' })
    ctl.runStarted() // a new reply replaces the unread one
    expect(ctl.getState()).toMatchObject({ phase: 'working', unread: false })
    ctl.runFinished({ kind: 'stopped' })
    expect(ctl.getState()).toMatchObject({ phase: 'idle', unread: false })
    vi.advanceTimersByTime(PREVIEW_MS * 2)
    expect(ctl.getState().phase).toBe('idle')
  })

  it('only notifies on real changes and dispose cancels the timer', () => {
    const { ctl, seen } = make()
    ctl.acknowledge()
    ctl.setPanelOpen(true)
    expect(seen).toHaveLength(0)
    ctl.setPanelOpen(false)
    ctl.runStarted()
    ctl.runFinished({ kind: 'done', text: 'A' })
    const count = seen.length
    ctl.dispose()
    vi.advanceTimersByTime(PREVIEW_MS * 2)
    expect(seen).toHaveLength(count)
  })
})
