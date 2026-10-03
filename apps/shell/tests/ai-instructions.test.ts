import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setSystemAddendum, withSystemAddendum } from '@genoffice/ai-provider'
import {
  INSTRUCTIONS_TEMPLATE,
  buildAddendum,
  createInstructionsFile,
  effectiveInstructions,
} from '../src/main/fork/ai-instructions'
import { normalizeReplyLanguage } from '../src/shared/fork/ai-instructions-meta'

describe('the instructions added to every AI turn', () => {
  it('asks for Vietnamese by default and names the language in English for the model', () => {
    const text = buildAddendum(normalizeReplyLanguage(undefined), '')
    expect(text).toContain('in Vietnamese')
    expect(text).toContain('tool-call arguments')
  })
  it('adds nothing for "auto" without instructions', () => {
    expect(buildAddendum('auto', '')).toBe('')
    expect(buildAddendum('auto', INSTRUCTIONS_TEMPLATE)).toBe('')
  })
  it("puts the person's own lines after the language rule and drops comments", () => {
    const raw = `<!-- note -->\n- Gọi tôi là anh.\n<!-- x\ny -->`
    expect(effectiveInstructions(raw)).toBe('- Gọi tôi là anh.')
    const text = buildAddendum('en', raw)
    expect(text.indexOf('in English')).toBeLessThan(text.indexOf('Gọi tôi là anh.'))
  })
  it('caps a huge file', () => {
    expect(effectiveInstructions('a'.repeat(50_000)).length).toBe(8000)
  })
  it('falls back to Vietnamese for an unknown language', () => {
    expect(normalizeReplyLanguage('klingon')).toBe('vi')
    expect(normalizeReplyLanguage('auto')).toBe('auto')
    expect(normalizeReplyLanguage('ja')).toBe('ja')
  })
})

describe('the instructions file', () => {
  it('is created with the template, and a change made in an editor is seen at once', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ai-ins-')), 'ai-instructions.md')
    const file = createInstructionsFile(path)
    expect(file.read()).toBe(INSTRUCTIONS_TEMPLATE)
    writeFileSync(path, '- ngắn gọn thôi', 'utf8')
    const later = new Date(Date.now() + 5000)
    utimesSync(path, later, later)
    expect(file.read()).toBe('- ngắn gọn thôi')
    file.write('- hai')
    expect(readFileSync(path, 'utf8')).toBe('- hai')
    expect(file.read()).toBe('- hai')
  })
})

describe('the system prompt hook of the provider layer', () => {
  afterEach(() => setSystemAddendum(null))
  it('appends the host text, and leaves the prompt alone without one or when it throws', () => {
    expect(withSystemAddendum('base')).toBe('base')
    setSystemAddendum(() => 'extra')
    expect(withSystemAddendum('base')).toBe('base\n\nextra')
    setSystemAddendum(() => '')
    expect(withSystemAddendum('base')).toBe('base')
    setSystemAddendum(() => {
      throw new Error('x')
    })
    expect(withSystemAddendum('base')).toBe('base')
  })
})
