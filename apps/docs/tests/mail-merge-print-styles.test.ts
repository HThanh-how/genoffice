/**
 * Mail merge preview decoration is an on-screen affordance. Chromium exports PDFs
 * with printBackground, so the green fill and the rounded corner would be baked
 * into every merged PDF. Both PDF paths — a single paper size and mixed paper
 * groups — print the same pagination-preview DOM, so one print-media block
 * covers both.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles.css'),
  'utf8',
)

/** Every `@media print { … }` block in the stylesheet. */
function printBlocks(text: string): string[] {
  const blocks: string[] = []
  for (let i = text.indexOf('@media print'); i >= 0; i = text.indexOf('@media print', i + 1)) {
    let depth = 0
    let end = i
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth += 1
      else if (text[j] === '}') {
        depth -= 1
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    blocks.push(text.slice(i, end + 1))
  }
  return blocks
}

const print = printBlocks(css).join('\n')
const ruleOf = (selector: string): string =>
  print.match(new RegExp(selector + '\\s*\\{[^}]*\\}'))?.[0] ?? ''

describe('mail merge print styles', () => {
  it('prints the recipient value as ordinary text, not as a preview chip', () => {
    const rule = ruleOf('\\.mm-field-preview-value')
    expect(rule).toContain('background: none')
    expect(rule).toContain('border-radius: 0')
  })

  it('never hides the recipient value in print', () => {
    const rule = ruleOf('\\.mm-field-preview-value')
    expect(rule).not.toContain('display: none')
    expect(rule).not.toContain('visibility: hidden')
    expect(rule).not.toContain('color: transparent')
    // the padding stays: pagination sliced the page boxes with the padded box
    // in the flow, so removing it would re-flow lines the pages were measured for
    expect(rule).not.toContain('padding')
  })

  it('keeps the «placeholder» hidden in print so it is not printed twice', () => {
    expect(css).toMatch(/\.mm-field-preview-src\s*\{[^}]*font-size:\s*0/)
    expect(ruleOf('\\.mm-field-preview-src')).toBe('')
  })

  it('still highlights merge fields on screen', () => {
    expect(css).toMatch(/\.mm-field-highlight\s*\{[^}]*background:/)
    expect(ruleOf('\\.mm-field-highlight')).toContain('background: none')
  })
})
