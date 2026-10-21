// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  canAutofocusDock,
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
