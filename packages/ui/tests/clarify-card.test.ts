/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { ClarifyCard, type ClarifyQuestion } from '../src/ClarifyCard'
import { clarifyText, type ClarifyKey } from '../src/strings-clarify'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const t = (key: ClarifyKey) => clarifyText('en', key)
const subject: ClarifyQuestion = {
  id: 'subject',
  label: 'Which subject?',
  header: 'Subject',
  options: ['Math', 'Language'],
  optionDescriptions: { Math: 'Numbers and geometry' },
}
const week: ClarifyQuestion = { id: 'week', label: 'Which week?', options: ['1', '2'] }
function mount(questions = [subject, week], allowDecide = false) {
  const onSubmit = vi.fn()
  const onSkip = vi.fn()
  act(() =>
    root.render(createElement(ClarifyCard, { questions, allowDecide, t, onSubmit, onSkip })),
  )
  return { onSubmit, onSkip }
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  expect(button, text).toBeTruthy()
  act(() => button!.click())
}
function other(value: string) {
  const input = host.querySelector('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('advances single select and returns every answer after the final choice', () => {
  const { onSubmit } = mount()
  expect(host.textContent).toContain('Numbers and geometry')
  expect(host.textContent).not.toContain('Decide for me')
  expect(host.querySelector('input')?.getAttribute('aria-label')).toBe('Other (type in)')
  click('Math')
  act(() => vi.advanceTimersByTime(250))
  expect(host.textContent).toContain('Which week?')
  expect(onSubmit).not.toHaveBeenCalled()
  click('2')
  act(() => vi.advanceTimersByTime(250))
  expect(onSubmit).toHaveBeenCalledWith(expect.any(String), [
    { q: 'Which subject?', a: 'Math' },
    { q: 'Which week?', a: '2' },
  ])
})

it('lets Other replace a single choice, cancels auto advance, and exposes Next', () => {
  const { onSubmit } = mount()
  click('Math')
  other('Science')
  act(() => vi.advanceTimersByTime(500))
  expect(host.textContent).toContain('Which subject?')
  click('Next')
  click('1')
  act(() => vi.advanceTimersByTime(250))
  expect(onSubmit).toHaveBeenCalledWith(expect.any(String), [
    { q: 'Which subject?', a: 'Science' },
    { q: 'Which week?', a: '1' },
  ])
})

it('waits for explicit submission of multiple selections and Other text', () => {
  const { onSubmit } = mount([{ ...subject, multi: true }])
  click('Math')
  click('Language')
  other('Science')
  act(() => vi.advanceTimersByTime(500))
  expect(onSubmit).not.toHaveBeenCalled()
  expect(host.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(2)
  click('Send')
  expect(onSubmit).toHaveBeenCalledWith(expect.any(String), [
    { q: 'Which subject?', a: 'Math、Language、Science' },
  ])
})

it('retains HTML decide-for-me behavior and cancels the pending timer on unmount', () => {
  const { onSubmit, onSkip } = mount([subject], true)
  click('Decide for me')
  click('Skip survey')
  expect(onSkip).toHaveBeenCalledOnce()
  act(() => root.render(null))
  act(() => vi.advanceTimersByTime(500))
  expect(onSubmit).not.toHaveBeenCalled()
})

it('submits only once when Send is clicked before the auto-submit timer', () => {
  const { onSubmit } = mount([subject])
  click('Math')
  click('Send')
  act(() => vi.advanceTimersByTime(500))
  expect(onSubmit).toHaveBeenCalledOnce()
})

it('provides every card key in every supported locale', () => {
  for (const lang of LANGS) {
    for (const key of [
      'aiClarifyOther',
      'aiClarifySubmit',
      'aiClarifyPrev',
      'aiClarifyNext',
      'aiClarifySkip',
    ] as const) {
      expect(clarifyText(lang, key), `${lang}.${key}`).toBeTruthy()
      expect(clarifyText(lang, key)).not.toBe(key)
    }
  }
})
