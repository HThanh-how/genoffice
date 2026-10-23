import { describe, expect, it } from 'vitest'
import { buildSnippet, containsAny, excerpt } from '../src/main/file-index/snippet'
import * as old from './snippet-reference'

function compare(text: string, needles: string[], chars = 160) {
  expect(buildSnippet(text, needles)).toEqual(old.buildSnippet(text, needles))
  expect(excerpt(text, needles, chars)).toEqual(old.excerpt(text, needles, chars))
  expect(containsAny(text, needles)).toEqual(old.containsAny(text, needles))
}

describe('bounded snippet matching', () => {
  it('matches the previous implementation on seeded multilingual strings', () => {
    let seed = 14
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % n
    }
    const alphabet = [
      'a',
      'Z',
      ' ',
      '\t',
      '\n',
      'việt',
      'ệ',
      '中',
      '東京',
      '한',
      'e\u0301',
      'a\u0323\u0302',
      'ﬃ',
      'Ａ',
      'İ',
      'Σ',
      '🙂',
      '\u0301',
    ]
    for (let i = 0; i < 700; i++) {
      const text = Array.from(
        { length: i < 600 ? random(450) : 2200 + random(1500) },
        () => alphabet[random(alphabet.length)],
      ).join('')
      const at = random(text.length || 1)
      compare(
        text,
        [text.slice(at, at + 1 + random(8)), alphabet[random(alphabet.length)], 'missing'],
        1 + random(350),
      )
    }
  })

  it('preserves offsets, boundaries, compaction and compatibility expansions across chunks', () => {
    for (let at = 1980; at < 2110; at += 3) {
      for (const [hit, needle] of [
        [' Việt Nam ', 'việt'],
        [' Ａﬃ ', 'ffi'],
        [' e\u0301 ', 'é'],
        ['中文', '中文'],
        [' İ ', 'i\u0307'],
      ]) {
        compare('文'.repeat(at) + hit + '文'.repeat(2800), [needle!])
      }
    }
    compare('x '.repeat(2500) + ' '.repeat(6000) + 'Việt Nam\n', ['việt'])
    compare('x '.repeat(3500), ['absent'])
    compare('x '.repeat(3500), [])
    compare(' \n'.repeat(3000) + 'head', [''])
    compare('x '.repeat(2500) + 'a'.repeat(6000), ['a'])
  }, 30_000)

  it('builds a page of 50 snippets from a 5 MB Vietnamese body within 500 ms', () => {
    const body = 'Việt Nam có những tài liệu tiếng Việt. '.repeat(150_000).slice(0, 5 * 1024 * 1024)
    const expected = old.buildSnippet(body.slice(0, 4096), ['việt'])
    const start = performance.now()
    const results = Array.from({ length: 50 }, () => buildSnippet(body, ['việt']))
    const elapsed = performance.now() - start
    for (const result of results) expect(result).toEqual(expected)
    expect(elapsed).toBeLessThan(500)
    const small = body.slice(0, 16_384)
    const before = performance.now()
    for (let i = 0; i < 50; i++) old.buildSnippet(small, ['việt'])
    const oldMs = performance.now() - before
    const after = performance.now()
    for (let i = 0; i < 50; i++) buildSnippet(small, ['việt'])
    console.log(
      JSON.stringify({
        benchmark: '50 snippets',
        old16KMs: oldMs,
        new16KMs: performance.now() - after,
        new5MBMs: elapsed,
        bodyChars: body.length,
      }),
    )
  }, 30_000)
})
