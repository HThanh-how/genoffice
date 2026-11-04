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

  it('finishes a 200 KB hostile string quickly (patterns never see more than a few KB)', () => {
    const hostile = [
      'a'.repeat(200_000),
      'a@'.repeat(100_000),
      'a.'.repeat(100_000),
      'token='.repeat(30_000),
      'Bearer '.repeat(30_000),
      'A1'.repeat(100_000),
      '1 '.repeat(100_000),
      'password:'.repeat(20_000),
      'cookie:'.repeat(30_000),
    ]
    for (const input of hostile) {
      const started = performance.now()
      redactString(input)
      expect(performance.now() - started).toBeLessThan(50)
    }
    const started = performance.now()
    redactValue({ message: 'x'.repeat(200_000), nested: { a: 'a@'.repeat(100_000) } })
    expect(performance.now() - started).toBeLessThan(50)
  })

  it.each([
    ['client_secret=abcd1234efgh', 'abcd1234efgh'],
    ['id_token=eyabcdefgh1234', 'eyabcdefgh1234'],
    ['session_token: abcdefgh1234', 'abcdefgh1234'],
    ['Cookie: a=b; session=abcd1234; other=zzzzzzzz', 'abcd1234'],
    ['Cookie: a=b; session=abcd1234; other=zzzzzzzz', 'zzzzzzzz'],
    ['Set-Cookie: sid=qwertyuiop; Path=/', 'qwertyuiop'],
    ['password: mat khau co dau cach', 'dau cach'],
    ['{"password":"two words here","next":1}', 'two words'],
    ['id 012 345 678 901', '345 678'],
    ['id 0123.4567.8901', '4567'],
    ['CCCD: 012345678', '012345678'],
    ['cmnd 012345678', '012345678'],
  ])('removes the secret from %s', (input, secret) => {
    expect(redactString(input)).not.toContain(secret)
  })

  it('keeps what is only prose or a measure', () => {
    expect(redactString('Basic settings were saved')).toBe('Basic settings were saved')
    expect(redactString('Basic information')).toBe('Basic information')
    expect(redactString('size 123456789 bytes at 1700000000000')).toBe(
      'size 123456789 bytes at 1700000000000',
    )
    expect(redactString('{"password":"two words here","next":1}')).toContain('"next"')
  })

  it('keeps the start of a digest so a commit or an installer hash can still be matched', () => {
    const sha = 'e63e1cff035a3a120484e0cceea6f9f518235700'
    const out = redactString(`commit ${sha}`)
    expect(out).toContain('e63e1cff035a')
    expect(out).not.toContain(sha)
    expect(out).toContain('[hex:40]')
  })

  it('treats key names that carry a secret like the plain ones', () => {
    const out = JSON.stringify(
      redactValue({
        accessToken: 'abcdef1234567890',
        clientSecret: 'zzzzzzzz9999',
        githubPassword: 'hunter2hunter2',
        messages: [{ role: 'user', text: 'private chat' }],
        history: ['private history'],
        system: 'private system prompt',
        selection: 'private selection',
        maxTokens: 4096,
      }),
    )
    for (const secret of ['abcdef1234567890', 'zzzzzzzz9999', 'hunter2', 'private']) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('"maxTokens":4096')
  })

  it('redacts the names of keys that are e-mail addresses', () => {
    const out = JSON.stringify(redactValue({ 'nguyen.van@example.com': 1 }))
    expect(out).not.toContain('nguyen.van')
  })

  it('does not hash short sensitive values (a PIN could be recovered from its hash)', () => {
    const out = redactValue({ password: '1234', prompt: 'a prompt that is long enough' }) as Record<
      string,
      any
    >
    expect(out.password).toEqual({ redacted: true, len: 4 })
    expect(out.prompt.hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('writes only the size of binary data, maps and sets', () => {
    const out = redactValue({
      buf: Buffer.from('secret file bytes'),
      u8: new Uint8Array([1, 2, 3]),
      map: new Map([['k', 'v']]),
      set: new Set([1, 2]),
    }) as Record<string, any>
    expect(out.buf).toEqual({ bytes: 17 })
    expect(out.u8).toEqual({ bytes: 3 })
    expect(out.map).toEqual({ size: 1 })
    expect(out.set).toEqual({ size: 2 })
  })

  it('redacts a personal number given as a number, but keeps measures', () => {
    const out = redactValue({
      cccdNumber: 12345678901,
      userNumber: 123456789,
      ms: 1700000000000,
      sizeBytes: 250000000,
      pid: 4242,
      createdAt: 1700000000000,
    }) as Record<string, any>
    expect(out.cccdNumber).toEqual({ redacted: true, type: 'number' })
    expect(out.userNumber).toEqual({ redacted: true, type: 'number' })
    expect(out.ms).toBe(1700000000000)
    expect(out.sizeBytes).toBe(250000000)
    expect(out.pid).toBe(4242)
    expect(out.createdAt).toBe(1700000000000)
  })

  it('cleans the cause of an error too', () => {
    const err = new Error('outer', { cause: new Error('inner Bearer abcdefghijklmnop1234') })
    expect(JSON.stringify(describeError(err))).not.toContain('abcdefghijklmnop1234')
  })
})
