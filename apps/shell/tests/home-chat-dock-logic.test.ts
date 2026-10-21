// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  canAutofocusDock,
  dockSearchQuery,
  showCreateCards,
  showAskHint,
  showDockExtra,
  pickSuggestions,
  showIndexChip,
} from '../src/renderer/src/home-chat/dock-logic'

const brief = (
  over: Partial<{ percent: number | null; waiting: number; errors: number; active: boolean }>,
) => ({
  percent: 100,
  waiting: 0,
  errors: 0,
  active: false,
  ...over,
})

describe('index chip', () => {
  it('is hidden before data, and when done with no problems', () => {
    expect(showIndexChip(null)).toBe(false)
    expect(showIndexChip(brief({}))).toBe(false)
  })
  it('shows while indexing or when there are problems', () => {
    expect(showIndexChip(brief({ active: true, percent: 0, waiting: 2 }))).toBe(true)
    expect(showIndexChip(brief({ errors: 3 }))).toBe(true)
  })
})

describe('quick suggestions', () => {
  const list = ['recent', 'progress', 'retry']
  it('never repeats the progress question and offers retry only with problems', () => {
    expect(pickSuggestions(list, null)).toEqual(['recent'])
    expect(pickSuggestions(list, brief({ errors: 0 }))).toEqual(['recent'])
    expect(pickSuggestions(list, brief({ errors: 2 }))).toEqual(['recent', 'retry'])
  })
})

describe('canAutofocusDock', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })
  it('allows an idle page', () => {
    expect(canAutofocusDock(document)).toBe(true)
  })
  it('refuses over a dialog', () => {
    document.body.innerHTML = '<div role="dialog"></div>'
    expect(canAutofocusDock(document)).toBe(false)
  })
  it('refuses while another field has focus', () => {
    document.body.innerHTML = '<input id="x">'
    document.getElementById('x')!.focus()
    expect(canAutofocusDock(document)).toBe(false)
  })
})

describe('dock search mode', () => {
  it('turns a plain word or file name into a search, trimmed', () => {
    expect(dockSearchQuery('  báo cáo ', false)).toBe('báo cáo')
    expect(dockSearchQuery('invoice 2026.pdf', false)).toBe('invoice 2026.pdf')
  })
  it('does not search for empty, one-character, command or question text', () => {
    expect(dockSearchQuery('', false)).toBe('')
    expect(dockSearchQuery(' a ', false)).toBe('')
    expect(dockSearchQuery('pause indexing', true)).toBe('')
    expect(dockSearchQuery('file nào nói về thuế?', false)).toBe('')
    expect(dockSearchQuery('what is in it？', false)).toBe('')
    expect(dockSearchQuery('summarise all of the contracts I signed last year', false)).toBe('')
  })
  it('hides the create cards only while a search is on', () => {
    expect(showCreateCards(true)).toBe(false)
    expect(showCreateCards(false)).toBe(true)
  })
  it('hides the model and usage row only while a search is on', () => {
    expect(showDockExtra(true)).toBe(false)
    expect(showDockExtra(false)).toBe(true)
  })
})

describe('inline Ask AI hint', () => {
  it('shows only while the text is a file search', () => {
    expect(showAskHint(dockSearchQuery('budget', false))).toBe(true)
    expect(showAskHint(dockSearchQuery('', false))).toBe(false)
    expect(showAskHint(dockSearchQuery('budget?', false))).toBe(false)
    expect(showAskHint(dockSearchQuery('pause indexing', true))).toBe(false)
    expect(showAskHint(dockSearchQuery('summarise all of the contracts I signed last year', false))).toBe(false)
  })
})
