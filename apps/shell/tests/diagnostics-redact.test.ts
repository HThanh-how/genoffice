import { describe, expect, it } from 'vitest'
import { describeError, redactString, redactValue } from '../src/main/diagnostics/redact'

describe('diagnostics redaction', () => {
  it.each([
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['key sk-abcdefghijklmnopqrstuvwxyz0123', 'sk-abcdefghijklmnopqrstuvwxyz0123'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstu', 'AIzaSyA1234567890abcdefghijklmnopqrstu'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['api_key=supersecretvalue', 'supersecretvalue'],
    ['{"token":"abcd1234efgh"}', 'abcd1234efgh'],
    ['https://x.test/cb?code=abc123def&state=zzz', 'abc123def'],
    ['mail me at nguyen.van@example.com', 'nguyen.van@example.com'],
    ['id 012345678901 here', '012345678901'],
    ['hash 0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567'],
  ])('removes the secret from %s', (input, secret) => {
    expect(redactString(input)).not.toContain(secret)
  })

  it('leaves ordinary text alone', () => {
    expect(redactString('handler ai:chat took 812 ms')).toBe('handler ai:chat took 812 ms')
  })

  it('replaces prompt-like fields by length and hash, never the content', () => {
    const out = redactValue({ channel: 'ai:chat', prompt: 'my secret question', n: 3 }) as Record<
      string,
      any
    >
    expect(out.channel).toBe('ai:chat')
    expect(out.n).toBe(3)
    expect(out.prompt).toMatchObject({ redacted: true, len: 18 })
    expect(JSON.stringify(out)).not.toContain('secret question')
  })

  it('applies to nested values and arrays', () => {
    const out = JSON.stringify(
      redactValue({ items: [{ content: 'file body here', headers: { cookie: 'a=b' } }] }),
    )
    expect(out).not.toContain('file body')
    expect(out).not.toContain('a=b')
  })

  it('verbose mode keeps a clipped, still-redacted copy', () => {
    const out = redactValue(
      { prompt: `use sk-abcdefghijklmnopqrstuvwxyz0123 ${'x'.repeat(400)}` },
      {
        verbose: true,
      },
    ) as { prompt: string }
    expect(out.prompt).not.toContain('sk-abcdefghijklmnop')
    expect(out.prompt.length).toBeLessThan(260)
  })

  it('bounds depth, arrays, and strings', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } }
    expect(JSON.stringify(redactValue(deep))).toContain('[depth]')
    const arr = redactValue(Array.from({ length: 100 }, (_, i) => i)) as unknown[]
    expect(arr.length).toBe(21)
    expect((redactValue('y'.repeat(5000)) as string).length).toBeLessThan(600)
  })

  it('hashes absolute paths only when asked', () => {
    const p = 'C:\\Users\\An\\Documents\\hop-dong.docx'
    expect(redactString(p)).toBe(p)
    const hashed = redactValue(p, { hashPaths: true }) as string
    expect(hashed).toMatch(/^\[path:[0-9a-f]{8}\]$/)
  })

  it('describes errors without leaking secrets in the message', () => {
    const err = Object.assign(new Error('failed with Bearer abcdefghijklmnop1234'), { code: 'E1' })
    const d = describeError(err)
    expect(d.code).toBe('E1')
    expect(JSON.stringify(d)).not.toContain('abcdefghijklmnop1234')
  })

  it('survives cyclic and odd values', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() =>
      JSON.stringify(redactValue({ a, f: () => 1, b: 10n, s: Symbol('x') })),
    ).not.toThrow()
  })
})
