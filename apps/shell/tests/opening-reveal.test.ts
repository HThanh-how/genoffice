import { describe, expect, it, vi } from 'vitest'
import {
  attachOpeningReveal,
  OPENING_REVEAL_CSS,
  OPENING_REVEAL_SCRIPT,
} from '../src/main/fork/opening-reveal'

describe('the editor ribbon revealing itself while a tab opens', () => {
  it('hides only ribbon controls, never layout, and its script is valid JavaScript', () => {
    expect(OPENING_REVEAL_CSS).toContain('html.gx-pre')
    expect(OPENING_REVEAL_CSS).toContain('opacity:0!important')
    expect(OPENING_REVEAL_CSS).not.toMatch(/display:\s*none|visibility:\s*hidden/)
    expect(() => new Function(OPENING_REVEAL_SCRIPT)).not.toThrow()
    // a template-literal escape slip once turned this into /S/, so no label ever decoded
    expect(OPENING_REVEAL_SCRIPT).toContain('/\S/.test(n.nodeValue)')
  })

  it('starts once the page has a document, and reports the ribbon height', async () => {
    let domReady: (() => void) | undefined
    const wc = {
      isDestroyed: () => false,
      once: vi.fn((event: string, fn: () => void) => {
        if (event === 'dom-ready') domReady = fn
      }),
      insertCSS: vi.fn(() => Promise.resolve('key')),
      executeJavaScript: vi.fn(() => Promise.resolve(132)),
    }
    const heights: number[] = []
    attachOpeningReveal(wc as never, (h) => heights.push(h))
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
    domReady?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(wc.insertCSS).toHaveBeenCalledWith(OPENING_REVEAL_CSS)
    expect(heights).toEqual([132])
  })

  it('ignores a page without a ribbon', async () => {
    let domReady: (() => void) | undefined
    const wc = {
      isDestroyed: () => false,
      once: (_e: string, fn: () => void) => void (domReady = fn),
      insertCSS: () => Promise.resolve('key'),
      executeJavaScript: () => Promise.resolve(0),
    }
    const heights: number[] = []
    attachOpeningReveal(wc as never, (h) => heights.push(h))
    domReady?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(heights).toEqual([])
  })
})
