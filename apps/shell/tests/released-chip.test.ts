// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { ReleasedChip } from '../src/renderer/src/fork/ReleasedChip'
import { strings } from '../src/renderer/src/indexing-activity-i18n'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

async function render(count: number | undefined, lang: 'vi' | 'en') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(LocaleProvider, { initial: lang }, createElement(ReleasedChip, { count })))
  })
  const html = host.innerHTML
  const title = host.querySelector('.idx-released-chip')?.getAttribute('title') ?? null
  await act(async () => root.unmount())
  host.remove()
  return { html, title }
}

it('shows a released badge with the explanatory tooltip and hides it for zero', async () => {
  const vi = await render(1234, 'vi')
  expect(vi.html).toContain('idx-released-chip')
  expect(vi.title).toBe(strings.vi.releasedHint)
  expect(vi.title).toContain('giải phóng')
  expect((await render(0, 'en')).html).toBe('')
  expect((await render(undefined, 'en')).html).toBe('')
})

it('has a label and tooltip in every locale', () => {
  for (const [lang, words] of Object.entries(strings)) {
    expect(words.released.length, lang).toBeGreaterThan(0)
    expect(words.releasedHint.length, lang).toBeGreaterThan(10)
  }
})
