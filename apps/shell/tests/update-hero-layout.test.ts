import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('update window hero layout', () => {
  it('keeps the artwork out of the flex layout despite the shared artwork styles', () => {
    const renderer = join(__dirname, '../src/renderer')
    const html = readFileSync(join(renderer, 'update.html'), 'utf8')
    const artworkCss = readFileSync(join(renderer, 'src/update-artwork.css'), 'utf8')

    expect(html).toMatch(/class="update-artwork update-artwork-hero"/)
    expect(html).toMatch(/\.update-artwork\.update-artwork-hero\s*\{[^}]*position:\s*absolute;/)
    expect(artworkCss).toMatch(/\.update-artwork\s*\{[^}]*position:\s*relative;/)
  })
})
