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

  it('redacts a personal number given as a number under a personal-number key, and keeps the rest', () => {
    const out = redactValue({
      cccdNumber: 12345678901,
      citizen_id: 123456789012 - 1,
      phone: 987654321,
      exitCode: 3221225477,
      status: 3221225477,
      heapUsed: 150000000,
      lastSeen: 1700000000000,
      bytesWritten: 250000000,
      free: 900000000,
      ms: 1700000000000,
      pid: 4242,
      telemetry: 123456789,
      syntaxLevel: 123456789,
      international: 123456789,
      microphone: 123456789,
    }) as Record<string, any>
    expect(out.cccdNumber).toEqual({ redacted: true, type: 'number' })
    expect(out.citizen_id).toEqual({ redacted: true, type: 'number' })
    expect(out.phone).toEqual({ redacted: true, type: 'number' })
    for (const key of [
      'exitCode',
      'status',
      'heapUsed',
      'lastSeen',
      'bytesWritten',
      'free',
      'ms',
      'pid',
      'telemetry',
      'syntaxLevel',
      'international',
      'microphone',
    ]) {
      expect(typeof out[key]).toBe('number')
    }
    expect(out.exitCode).toBe(3221225477)
  })

  it('redacts whole trees under secret-named keys, but keeps counters', () => {
    const out = JSON.stringify(
      redactValue({
        apiKeys: ['abcdef123456'],
        secrets: { a: 'plainsecret' },
        tokens: { input: 5, output: 7 },
        tokenCount: 12,
      }),
    )
    expect(out).not.toContain('abcdef123456')
    expect(out).not.toContain('plainsecret')
    expect(out).toContain('"input":5')
    expect(out).toContain('"tokenCount":12')
  })

  it('keeps the skeleton of content containers: roles and flags stay, text goes', () => {
    const out = redactValue({
      messages: [
        { role: 'user', text: 'tell me about my salary please', partial: true, n: 3 },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'edit_cell', input: { a1: 'secret value here' } }],
        },
      ],
    }) as any
    expect(out.messages[0].role).toBe('user')
    expect(out.messages[0].partial).toBe(true)
    expect(out.messages[0].n).toBe(3)
    expect(JSON.stringify(out)).not.toContain('salary')
    expect(JSON.stringify(out)).not.toContain('secret value')
    expect(out.messages[1].role).toBe('assistant')
  })

  it('does not throw on an invalid date', () => {
    expect(() => redactValue({ at: new Date('nope') })).not.toThrow()
    expect((redactValue({ at: new Date('nope') }) as any).at).toBe('Invalid Date')
  })

  it('cleans the cause of an error too', () => {
    const err = new Error('outer', { cause: new Error('inner Bearer abcdefghijklmnop1234') })
    expect(JSON.stringify(describeError(err))).not.toContain('abcdefghijklmnop1234')
  })

  it('reads key names word by word: every spelling of a secret is masked', () => {
    const secret = 'hunter2-abc-def'
    const out = JSON.stringify(
      redactValue({
        secretKey: secret,
        accessKey: secret,
        secretAccessKey: secret,
        AWS_SECRET_ACCESS_KEY: secret,
        pwd: secret,
        passcode: secret,
        passwordHash: secret,
        pin: secret,
        otp: secret,
        key: secret,
        auth: secret,
        sessionId: secret,
        jwt: secret,
        'x-api-key': secret,
        signature: secret,
      }),
    )
    expect(out).not.toContain(secret)
  })

  it('masks a password or a PIN given as a number, but not counters with a similar name', () => {
    const out = redactValue({
      password: 12345678,
      pin: 1234,
      otp: 987654,
      passwordLength: 12,
      tokenCount: 12,
      maxTokens: 4096,
      keys: 5,
      keyboard: 'qwerty',
      tokens: { input: 5, output: 7 },
    }) as Record<string, any>
    expect(out.password).toEqual({ redacted: true, type: 'number' })
    expect(out.pin).toEqual({ redacted: true, type: 'number' })
    expect(out.otp).toEqual({ redacted: true, type: 'number' })
    expect(out.passwordLength).toBe(12)
    expect(out.tokenCount).toBe(12)
    expect(out.maxTokens).toBe(4096)
    expect(out.keys).toBe(5)
    expect(out.keyboard).toBe('qwerty')
    expect(out.tokens).toEqual({ input: 5, output: 7 })
  })

  it('masks personal numbers whatever the type, the spelling or the container', () => {
    const out = JSON.stringify(
      redactValue({
        cmnd: '012345678',
        cccd: '012345678',
        phone: '0912345678',
        CCCDNumber: 912345678,
        idNumber: 912345678,
        nationalId: '079203001234',
        socialSecurity: '12-34',
        phonenumber: '0912345678',
        sdt: '0912345678',
        soDienThoai: '0912345678',
        stk: '123456789',
        mst: '0101234567',
        cmtnd: '123456789',
        idCard: '123456789',
        citizenship: 'VN-123',
        telephone: '0912345678',
        phones: [912345678, 912345679],
        bhxh: '1234567890',
        nested: { ssn: 123456789n, cccd_no: 79203001234 },
      }),
    )
    for (const value of [
      '012345678',
      '0912345678',
      '912345678',
      '079203001234',
      '0101234567',
      '123456789',
      '79203001234',
      '1234567890',
    ]) {
      expect(out).not.toContain(value)
    }
  })

  it('does not mistake other words for personal numbers', () => {
    const out = redactValue({
      telemetry: 123456789,
      syntaxLevel: 123456789,
      international: 123456789,
      microphone: 123456789,
      classname: 'a-class',
      accountType: 'free',
    }) as Record<string, any>
    for (const key of ['telemetry', 'syntaxLevel', 'international', 'microphone']) {
      expect(out[key]).toBe(123456789)
    }
    expect(out.classname).toBe('a-class')
    expect(out.accountType).toBe('free')
  })

  it('writes a bigint through the string rules', () => {
    expect(redactValue({ big: 123456789012n })).toEqual({ big: '[id]' })
  })

  it('inside content containers, short text is masked unless the key names an identifier', () => {
    const out = JSON.stringify(
      redactValue({
        messages: ['hunter2'],
        args: ['password123', '--token', 'abc'],
        params: { pin: '123456', name: 'Alice', model: 'claude-x', toolUseId: 'tu_1' },
        context: { user: 'nguyenvana', role: 'owner' },
        parts: ['hello'],
      }),
    )
    for (const text of [
      'hunter2',
      'password123',
      '--token',
      'Alice',
      'nguyenvana',
      'hello',
      '123456',
    ]) {
      expect(out).not.toContain(text)
    }
    for (const kept of ['claude-x', 'tu_1', 'owner']) expect(out).toContain(kept)
  })

  it('reduces a large thrown object to bounded data before it becomes text', () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 40; i++) big[`k${i}`] = 'v'.repeat(500)
    describeError(big) // warm up
    const started = performance.now()
    const described = describeError(big)
    expect(performance.now() - started).toBeLessThan(20)
    expect(String(described.message).length).toBeLessThan(600)
  })
})
