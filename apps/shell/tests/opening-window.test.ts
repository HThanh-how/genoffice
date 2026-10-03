import { describe, expect, it } from 'vitest'
import { openingPageHtml, openingWords } from '../src/main/fork/opening-window'

describe('the "Opening…" panel for a legacy file', () => {
  it('says what is happening, in Vietnamese or English', () => {
    expect(openingWords('vi', 'doc').title).toBe('Đang mở tài liệu…')
    expect(openingWords('en', 'ppt').title).toBe('Opening presentation…')
    // the shell's other languages keep English
    expect(openingWords('zh', 'doc')).toEqual(openingWords('en', 'doc'))
  })

  it('shows the file name and cannot be turned into markup by it', () => {
    const html = openingPageHtml(openingWords('en', 'doc'), '<img src=x onerror=alert(1)>.doc')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.doc')
    expect(html).not.toContain('<img')
    // no script can run in it, and nothing can be loaded
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/<script/i)
  })

  it('follows the system light or dark setting', () => {
    const html = openingPageHtml(openingWords('vi', 'doc'), 'a.doc')
    expect(html).toContain('prefers-color-scheme:dark')
  })
})
