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
    const out = redactString(`installer sha256 ${sha}`)
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
    expect(performance.now() - started).toBeLessThan(150) // generous: the suite runs loaded
    expect(String(described.message).length).toBeLessThan(600)
  })

  it('keeps diagnostics that only look like secrets by name (judged by value)', () => {
    const out = redactValue({
      key: 'F5',
      primaryKey: 'id',
      cacheKey: 'doc:12',
      sortKey: 'name',
      i18nKey: 'menu.file',
      idempotencyKey: '3f2b8c1e-0a4d-4f6e-9b7a-1c2d3e4f5a6b',
      authMode: 'oauth',
      authStatus: 'ok',
      tokenType: 'Bearer',
      hmacAlgo: 'sha256',
      secretName: 'db_password',
      cookieName: 'sid',
      credentialsPath: 'config',
      signatureCount: 'three',
      sessionId: '3f2b8c1e-0a4d-4f6e-9b7a-1c2d3e4f5a6b',
      conversationId: '3f2b8c1e-0a4d-4f6e-9b7a-1c2d3e4f5a6b',
      keys: ['a', 'b'],
    }) as Record<string, any>
    for (const [key, value] of Object.entries(out)) {
      expect(typeof value === 'object' && value !== null && 'redacted' in value, key).toBe(false)
    }
  })

  it('still masks the value when it looks like a secret under a weak name', () => {
    const secret = 'sk_live_abcdef1234567890'
    const out = JSON.stringify(
      redactValue({
        key: secret,
        cacheKey: secret,
        authMode: secret,
        tokenType: secret,
        sessionId: 'abcdefghijklmnopqrstuvwxyz0123456789',
        cookie_header_value: 'a=b; session=zzzzzzzz',
        cookieName: 'a=b; c=zzzzzzzz',
        keys: [secret],
      }),
    )
    expect(out).not.toContain(secret)
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(out).not.toContain('zzzzzzzz')
  })

  it('masks Vietnamese and uncommon secret and personal names', () => {
    const out = JSON.stringify(
      redactValue({
        matKhau: 'abc-1234',
        mat_khau: 'abc-1234',
        MatKhau: 'abc-1234',
        maSoThue: '0101234567',
        masothue: '0101234567',
        soTaiKhoan: '0123456789',
        sotaikhoan: '0123456789',
        soHoChieu: 'B1234567',
        recoveryCode: 'abcd-efgh',
        verificationCode: '123456',
        smsCode: '123456',
        mnemonic: 'word word word',
        connectionString: 'Server=x;Password=y',
        dsn: 'postgres://u:p@h/db',
        passkey: 'abc',
        privatekey: 'abc',
        keyMaterial: 'abc',
        authorizationHeader: 'Bearer abcdefgh',
        fullName: 'Nguyen Van An',
        hoTen: 'Nguyen Van An',
        ngaySinh: '01/02/1990',
        dob: '1990-02-01',
        homeAddress: '12 Le Loi',
        diaChi: '12 Le Loi',
      }),
    )
    for (const value of [
      'abc-1234',
      '0101234567',
      '0123456789',
      'B1234567',
      'abcd-efgh',
      '123456',
      'word word',
      'Server=',
      'postgres',
      'Nguyen Van An',
      '1990',
      '12 Le Loi',
      'abcdefgh',
    ]) {
      expect(out).not.toContain(value)
    }
  })

  it('masks a PEM block inside text', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
    const out = redactString(`failed to load ${pem} from disk`)
    expect(out).not.toContain('MIIEvQ')
    expect(out).toContain('[pem]')
    expect(out).toContain('from disk')
  })

  it('keeps counters and other words that merely share letters with personal names', () => {
    const out = redactValue({
      phoneCount: 3,
      cccdCount: 2,
      mstCount: 1,
      stkCount: 1,
      telephoneCount: 4,
      idCardCount: 5,
      accountId: 123456789012,
      mobile: 'ios',
      mobileApp: 'ios',
      cmt: 'comment text',
      citizen: 'vn',
      boardingPass: 'gate 4',
      nationalIdentifier: 'x',
      ipAddress: '10.0.0.1',
    }) as Record<string, any>
    for (const key of [
      'phoneCount',
      'cccdCount',
      'mstCount',
      'stkCount',
      'telephoneCount',
      'idCardCount',
    ]) {
      expect(typeof out[key]).toBe('number')
    }
    expect(out.accountId).toBe(123456789012)
    expect(out.mobile).toBe('ios')
    expect(out.mobileApp).toBe('ios')
    expect(out.cmt).toBe('comment text')
    expect(out.citizen).toBe('vn')
    expect(out.boardingPass).toBe('gate 4')
    expect(out.nationalIdentifier).toBe('x')
    expect(out.ipAddress).toBe('10.0.0.1')
  })

  it('judges a key name once: 10,000 lines of 25 keys stay cheap', () => {
    const line = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`field${i}`, i % 2 ? i : `value ${i}`]),
    )
    redactValue(line) // warm up
    const started = performance.now()
    for (let i = 0; i < 10_000; i++) redactValue(line)
    // about 25 keys a line; the old per-key word splitting cost ~110 microseconds a line more
    expect(performance.now() - started).toBeLessThan(10_000) // loose: it only has to show that names are not re-analysed
  })

  it('masks compound and run-together password and key names', () => {
    const out = JSON.stringify(
      redactValue({
        confirmpassword: 'hunter2',
        newpassword: 'hunter2',
        dbpassword: 'hunter2',
        passWord: 'hunter2',
        pass_word: 'hunter2',
        apiKey: 'abcdefgh',
        x_api_key: 'demo-key',
        APIKey: 'testkey1',
      }),
    )
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('abcdefgh')
    expect(out).not.toContain('demo-key')
    expect(out).not.toContain('testkey1')
  })

  it.each([
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI'],
    ['secret_key=AbCdEf123', 'AbCdEf123'],
    ['signing_key: abcdef12', 'abcdef12'],
    ['encryption_key=abcdef12', 'abcdef12'],
    ['run --password hunter2 now', 'hunter2'],
    ['run --token abcdef123456', 'abcdef123456'],
    ['run --api-key=abcdef123456', 'abcdef123456'],
    ['curl -u admin:hunter2 https://x.test', 'hunter2'],
    ['pass=abc123', 'abc123'],
    ['PASS=hunter2', 'hunter2'],
    ['mongodb://u:p4ss@localhost/x', 'p4ss'],
    ['postgres://admin:s3cr3t@db.internal:5432/app', 's3cr3t'],
    ['Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['authHeader: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----',
      'lQOYBF',
    ],
    ['call 0912345678 now', '0912345678'],
    ['call +84 912 345 678 now', '912 345 678'],
    ['card 4111 1111 1111 1111 ok', '4111 1111'],
    ['card 4111111111111111 ok', '4111111111111111'],
  ])('removes the secret from the free text %s', (input, secret) => {
    expect(redactString(input)).not.toContain(secret)
  })

  it('keeps ordinary prose and numbers that only resemble those', () => {
    for (const text of [
      'Basic settings were saved',
      'Basic configuration loaded',
      'the compass=north',
      'mongodb://localhost:27017/x',
      'build 1700000000000 took 12 ms',
      'sizes 123456789 and 0 bytes',
    ]) {
      expect(redactString(text)).toBe(text)
    }
  })

  it('keeps long namespaced names that are not secrets', () => {
    const out = redactValue({
      cacheKey: 'doc:12345678',
      translationKey: 'menu.file2',
      key: 'Ctrl+Shift+P',
      storageKey: 'genoffice.settings.v2',
    }) as Record<string, any>
    for (const value of Object.values(out)) expect(typeof value).toBe('string')
  })

  it('masks more personal names and values: bank accounts, card numbers, user names', () => {
    const out = JSON.stringify(
      redactValue({
        bankAccount: '0123456789',
        cardNumber: '4111111111111111',
        username: 'nguyenvana',
        tenDangNhap: 'nguyenvana',
        zalo: '0912345678',
        birthdate: '1990-02-01',
        soCMT: '123456789',
      }),
    )
    for (const value of [
      '0123456789',
      '4111111111111111',
      'nguyenvana',
      '0912345678',
      '1990-02-01',
      '123456789',
    ]) {
      expect(out).not.toContain(value)
    }
  })

  it('does not keep a value that looks random just because it has a dot or a colon in it', () => {
    const out = JSON.stringify(
      redactValue({
        auth: 'admin:hunter22',
        token: 'abcd1234efgh5678.ijkl9012mnop3456',
        key: '0123456789abcdef.fedcba9876543210',
        accessToken: 'user:Xk39sLq02mZpR7vB',
        sessionKey: 'Xk39sLq02mZpR7vB+Qw81nLp04ZsV3aT',
      }),
    )
    for (const secret of [
      'hunter22',
      'abcd1234efgh',
      '0123456789abcdef',
      'Xk39sLq02mZpR7vB',
      'Qw81nLp04',
    ]) {
      expect(out).not.toContain(secret)
    }
  })

  it('reads the end of a very long key name too', () => {
    const out = JSON.stringify(redactValue({ [`${'x'.repeat(100)}_password`]: 'hunter2hunter2' }))
    expect(out).not.toContain('hunter2hunter2')
  })

  it('looks at a bounded number of values in a huge tree', () => {
    const wide = (depth: number): unknown =>
      depth === 0
        ? 'leaf'
        : Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, wide(depth - 1)]))
    const started = performance.now()
    redactValue({ a: wide(4), b: wide(4), c: wide(4) })
    expect(performance.now() - started).toBeLessThan(500)
  })

  it.each([
    ['redis://:secretpw@host:6379', 'secretpw'],
    ['mongodb://u:p@ss@host/x', 'ss@'],
    ['key sk_live_abcdefgh12345678', 'abcdefgh12345678'],
    ['key pk_test_abcdefgh12345678', 'abcdefgh12345678'],
    ['glpat-abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
    ['hf_abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx'],
    ['xoxb-1234567890-abcdefghij', '1234567890'],
  ])('removes the secret from %s', (input, secret) => {
    expect(redactString(input)).not.toContain(secret)
  })

  it('does not take every long digit run for a card, nor an English word for Basic credentials', () => {
    // 16-digit runs that pass the check digit but do not start like a card number
    expect(redactString('t=1700000000000042')).toBe('t=1700000000000042')
    expect(redactString('Basic Configuration loaded')).toBe('Basic Configuration loaded')
    expect(redactString('Basic Authentication failed')).toBe('Basic Authentication failed')
    expect(redactString('card 5500005555555559')).toContain('[card]')
  })

  it('masks more names: dbpass, pw, cvv, cvc, iban, creditCard, securityAnswer', () => {
    const secret = 'abcdefghijkl'
    const out = JSON.stringify(
      redactValue({
        dbpass: secret,
        pw: secret,
        cvv: secret,
        cvc: secret,
        iban: secret,
        creditCard: secret,
        securityAnswer: secret,
      }),
    )
    expect(out).not.toContain(secret)
  })

  it('keeps a UUID whole, also when its last group is made of digits only', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    expect(redactString(`session ${uuid} started`)).toBe(`session ${uuid} started`)
    expect(redactValue({ sessionId: uuid, conversationId: uuid })).toEqual({
      sessionId: uuid,
      conversationId: uuid,
    })
    // a secret next to it is still removed
    expect(redactString(`id ${uuid} api_key=abcdef123456`)).toBe(`id ${uuid} api_key=[redacted]`)
    // and a UUID given as the secret itself goes with it
    expect(redactString(`token=${uuid}`)).not.toContain('426614174000')
  })

  it('keeps the whole git commit hash after the word commit, but still shortens other long hex', () => {
    const sha = 'e63e1cff035a3a120484e0cceea6f9f518235700'
    expect(redactString(`commit ${sha}`)).toBe(`commit ${sha}`)
    expect(redactString(`rev=${sha}`)).toBe(`rev=${sha}`)
    expect(redactString(`digest ${sha}`)).not.toContain(sha)
  })

  it('removes a token that is a UUID, or starts with one, whatever surrounds it', () => {
    const uuid = '3f2b8c1a-9d4e-4a7b-8c21-0123456789ab'
    for (const text of [
      `Bearer ${uuid}`,
      `sk-${uuid}`,
      `token=${uuid}.TAIL9876`,
      `token=${uuid}:TAIL9876`,
      `secret=${uuid}/x9KqTAIL`,
    ]) {
      const out = redactString(text)
      expect(out, text).not.toContain('0123456789ab')
      expect(out, text).not.toContain('TAIL')
      expect(out, text).not.toContain('x9Kq')
    }
  })

  it('masks a UUID under a key that names a credential, keeps it under an identifier key', () => {
    const uuid = '3f2b8c1a-9d4e-4a7b-8c21-0123456789ab'
    const out = redactValue({
      token: uuid,
      accessToken: uuid,
      refreshToken: uuid,
      authToken: uuid,
      sessionToken: uuid,
      csrfToken: uuid,
      licenseKey: uuid,
      auth: uuid,
      jwt: uuid,
      signature: uuid,
      sessionId: uuid,
      requestId: uuid,
      traceId: uuid,
      idempotencyKey: uuid,
      ids: { sessionIds: [uuid] },
    }) as Record<string, any>
    for (const key of [
      'token',
      'accessToken',
      'refreshToken',
      'authToken',
      'sessionToken',
      'csrfToken',
      'licenseKey',
      'auth',
      'jwt',
      'signature',
    ]) {
      expect(out[key], key).toMatchObject({ redacted: true })
    }
    for (const key of ['sessionId', 'requestId', 'traceId', 'idempotencyKey'])
      expect(out[key], key).toBe(uuid)
    expect(out.ids.sessionIds).toEqual([uuid])
  })

  it('catches the shorter random-looking parts (6 or more characters) and more free-text names', () => {
    const out = JSON.stringify(
      redactValue({ auth: 'admin:pass123', token: 'abc1234.def5678', key: 'abc1234+def5678' }),
    )
    for (const secret of ['pass123', 'abc1234', 'def5678']) expect(out).not.toContain(secret)
    for (const [text, secret] of [
      ['dbpass=hunter2', 'hunter2'],
      ['mypw=bob', 'bob'],
      ['cvv=123', '123'],
      ['cvc: 123', '123'],
      ['securityAnswer=blue', 'blue'],
      ['iban: GB82WEST12345698765432', 'GB82WEST'],
      ['call 028 3822 1234 now', '3822'],
      ['call +84 28 3822 1234 now', '3822'],
    ] as const) {
      expect(redactString(text), text).not.toContain(secret)
    }
  })

  it('past the text budget a string is only measured, never read', () => {
    const big = Array.from({ length: 100 }, (_, i) => ({
      [`k${i}`]: 'x'.repeat(4000),
    }))
    const started = performance.now()
    const out = JSON.stringify(redactValue({ list: big, password: 'hunter2hunter2' }))
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(out).not.toContain('hunter2hunter2')
    // the later strings were not read: they are lengths
    expect(out).toContain('"redacted":true')
  })

  it('does not build a list of entries for a huge object', () => {
    const huge: Record<string, number> = {}
    for (let i = 0; i < 300_000; i++) huge[`k${i}`] = i
    const started = performance.now()
    const out = redactValue(huge) as Record<string, unknown>
    expect(performance.now() - started).toBeLessThan(500)
    expect(Object.keys(out).length).toBeLessThanOrEqual(42)
  })

  it('a UUID inside a credential key is a credential, however deep, and an identifier key keeps its UUIDs', () => {
    const uuid = '3f2b8c1a-9d4e-4a7b-8c21-0123456789ab'
    const out = JSON.stringify(
      redactValue({
        token: { value: uuid },
        auth: { k: uuid, more: [uuid] },
        accessToken: [{ a: uuid }],
        sessionId: { id: uuid },
        requestIds: [uuid],
      }),
    )
    const parsed = JSON.parse(out)
    expect(parsed.token.value).toMatchObject({ redacted: true })
    expect(parsed.auth.k).toMatchObject({ redacted: true })
    expect(parsed.auth.more[0]).toMatchObject({ redacted: true })
    expect(parsed.accessToken[0].a).toMatchObject({ redacted: true })
    expect(parsed.sessionId.id).toBe(uuid)
    expect(parsed.requestIds[0]).toBe(uuid)
  })
})
