import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockedUnlink = vi.hoisted(() => vi.fn())
const mockedReadFile = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  mockedUnlink.mockImplementation((...args: Parameters<typeof actual.unlink>) =>
    actual.unlink(...args),
  )
  mockedReadFile.mockImplementation((...args: Parameters<typeof actual.readFile>) =>
    actual.readFile(...args),
  )
  return {
    ...actual,
    unlink: mockedUnlink,
    readFile: mockedReadFile,
  }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

import {
  HomeChatStore,
  cleanChatTitle,
  deriveChatTitle,
  fitSessionBytes,
  isChatSessionId,
  sanitizeChatMessages,
} from '../src/main/fork/home-chat-store'
import { HOME_CHAT_LIMITS } from '../src/shared/fork/home-chat-types'

let dir: string
let store: HomeChatStore

beforeEach(async () => {
  mockedUnlink.mockReset()
  mockedUnlink.mockImplementation((...args: any[]) => (actualFs.unlink as any)(...args))
  mockedReadFile.mockReset()
  mockedReadFile.mockImplementation((...args: any[]) => (actualFs.readFile as any)(...args))
  dir = await mkdtemp(join(tmpdir(), 'home-chat-'))
  store = new HomeChatStore(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const convo = (q: string, a = 'answer') => [
  { role: 'user' as const, text: q },
  { role: 'assistant' as const, text: a },
]

describe('home chat helpers', () => {
  it('derives a one-line trimmed title', () => {
    expect(deriveChatTitle(convo('  find   my\nbudget  '))).toBe('find my budget')
    const long = deriveChatTitle(convo('x'.repeat(300)))
    expect(long.length).toBe(HOME_CHAT_LIMITS.maxTitleChars)
    expect(long.endsWith('\u2026')).toBe(true)
    expect(deriveChatTitle([])).toBe('')
  })

  it('cleans titles of control characters and non-strings', () => {
    expect(cleanChatTitle('a\u0000b\u001fc')).toBe('a b c')
    expect(cleanChatTitle(42)).toBe('')
  })

  it('accepts only uuid ids (no path traversal)', () => {
    expect(isChatSessionId('3f2b8c1e-9a4d-4c7e-8b21-0a1b2c3d4e5f')).toBe(true)
    for (const bad of ['../x', 'index', '', 'a/b', '3f2b8c1e-9a4d-4c7e-8b21-0a1b2c3d4e5f.json', 5])
      expect(isChatSessionId(bad)).toBe(false)
  })

  it('keeps only role/text/sources/error and drops anything else', () => {
    const cleaned = sanitizeChatMessages([
      {
        role: 'assistant',
        text: 'hi',
        apiKey: 'sk-secret',
        toolCalls: [{ name: 'x' }],
        error: 'boom',
        sources: [
          { documentId: 3, name: 'a.docx', location: 'p1', stale: true, path: 'C:\\secret' },
          { documentId: -1, name: 'bad' },
          { documentId: 3, name: 'dupe' },
        ],
      },
      { role: 'system', text: 'nope' },
      { role: 'user' },
      'junk',
    ])
    expect(cleaned).toEqual([
      {
        role: 'assistant',
        text: 'hi',
        error: 'boom',
        sources: [
          { documentId: 3, name: 'a.docx', location: 'p1', stale: true, path: 'C:\\secret' },
        ],
      },
    ])
  })

  it('trims to the newest messages that fit the byte budget, starting on a user turn', () => {
    const messages = [
      ...convo('first', 'a'.repeat(400)),
      ...convo('second', 'b'.repeat(400)),
      ...convo('third', 'c'.repeat(10)),
    ]
    const fitted = fitSessionBytes(messages, 600)
    expect(fitted[0]!.role).toBe('user')
    expect(fitted.at(-1)!.text).toBe('c'.repeat(10))
    expect(fitted.length).toBeLessThan(messages.length)
  })
})

describe('HomeChatStore', () => {
  it('creates a session with a generated id and an auto title', async () => {
    const saved = await store.save({ messages: convo('Find the budget') })
    expect(saved).not.toBeNull()
    expect(isChatSessionId(saved!.id)).toBe(true)
    expect(saved!.title).toBe('Find the budget')
    expect(saved!.messageCount).toBe(2)
    const loaded = await store.get(saved!.id)
    expect(loaded!.messages).toEqual(convo('Find the budget'))
    expect(await store.list()).toHaveLength(1)
  })

  it('updates in place, keeps title and createdAt, and bumps updatedAt', async () => {
    const first = await store.save({ messages: convo('one') })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await store.save({
      id: first!.id,
      title: 'ignored on update',
      messages: [...convo('one'), ...convo('two')],
    })
    expect(second!.id).toBe(first!.id)
    expect(second!.title).toBe('one')
    expect(second!.createdAt).toBe(first!.createdAt)
    expect(second!.updatedAt).toBeGreaterThan(first!.updatedAt)
    expect(second!.messageCount).toBe(4)
    expect(await store.list()).toHaveLength(1)
  })

  it('rejects invalid ids, empty and non-object input', async () => {
    expect(await store.save({ id: '../evil', messages: convo('x') })).toBeNull()
    expect(await store.save({ messages: [] })).toBeNull()
    expect(await store.save('nope')).toBeNull()
    expect(await store.get('../evil')).toBeNull()
    expect(await store.rename('../evil', 'x')).toBeNull()
    expect(await store.delete('../evil')).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('renames and rejects blank titles', async () => {
    const saved = await store.save({ messages: convo('hello') })
    expect(await store.rename(saved!.id, '   ')).toBeNull()
    const renamed = await store.rename(saved!.id, '  Quarterly  plan ')
    expect(renamed!.title).toBe('Quarterly plan')
    expect((await store.get(saved!.id))!.title).toBe('Quarterly plan')
    expect((await store.list())[0]!.title).toBe('Quarterly plan')
  })

  it('deletes one session and can re-create it with the same id (undo)', async () => {
    const saved = await store.save({ messages: convo('keep me') })
    const full = (await store.get(saved!.id))!
    expect(await store.delete(saved!.id)).toBe(true)
    expect(await store.get(saved!.id)).toBeNull()
    expect(await store.list()).toEqual([])
    const restored = await store.save({
      id: full.id,
      title: full.title,
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
      messages: full.messages,
    })
    expect(restored!.id).toBe(full.id)
    expect(restored!.createdAt).toBe(full.createdAt)
    expect(restored!.updatedAt).toBe(full.updatedAt)
  })

  it('clears everything', async () => {
    await store.save({ messages: convo('a') })
    await store.save({ messages: convo('b') })
    expect(await store.clear()).toBe(2)
    expect(await store.list()).toEqual([])
    expect((await readdir(dir)).filter((name) => name !== 'index.json')).toEqual([])
  })

  it('sorts newest first', async () => {
    const a = await store.save({ messages: convo('older') })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await store.save({ messages: convo('newer') })
    expect((await store.list()).map((s) => s.id)).toEqual([b!.id, a!.id])
  })

  it('survives a corrupt index by rebuilding it from the session files', async () => {
    const saved = await store.save({ messages: convo('persist me') })
    await writeFile(join(dir, 'index.json'), '{not json')
    const fresh = new HomeChatStore(dir)
    const list = await fresh.list()
    expect(list.map((s) => s.id)).toEqual([saved!.id])
    expect(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')).sessions).toHaveLength(1)
  })

  it('skips and quarantines a corrupt session file instead of failing the list', async () => {
    const good = await store.save({ messages: convo('good') })
    const badId = '11111111-2222-4333-8444-555555555555'
    await writeFile(join(dir, `${badId}.json`), 'garbage{{')
    await rm(join(dir, 'index.json'))
    const fresh = new HomeChatStore(dir)
    expect((await fresh.list()).map((s) => s.id)).toEqual([good!.id])
    const files = await readdir(dir)
    expect(files).not.toContain(`${badId}.json`)
    const quarantined = files.find((name) => name.startsWith(`${badId}.json.corrupt-`))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe('garbage{{')
  })

  it('returns null and drops the index entry when a session file vanished', async () => {
    const saved = await store.save({ messages: convo('ghost') })
    await rm(join(dir, `${saved!.id}.json`))
    expect(await store.get(saved!.id)).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it('never persists extra fields (keys, settings) from the renderer', async () => {
    const saved = await store.save({
      messages: [
        { role: 'user', text: 'hi', apiKey: 'sk-1' },
        { role: 'assistant', text: 'yo' },
      ],
      settings: { apiKey: 'sk-2' },
    })
    const raw = await readFile(join(dir, `${saved!.id}.json`), 'utf8')
    expect(raw).not.toContain('sk-1')
    expect(raw).not.toContain('sk-2')
  })

  it('caps the number of sessions, evicting the oldest', async () => {
    const small = new HomeChatStore(dir)
    const ids: string[] = []
    for (let i = 0; i < HOME_CHAT_LIMITS.maxSessions + 3; i += 1) {
      const saved = await small.save({ messages: convo(`chat ${i}`) })
      ids.push(saved!.id)
    }
    const list = await small.list()
    expect(list).toHaveLength(HOME_CHAT_LIMITS.maxSessions)
    expect(list.some((s) => s.id === ids[0])).toBe(false)
    expect(list.some((s) => s.id === ids.at(-1))).toBe(true)
    expect((await readdir(dir)).filter((n) => n !== 'index.json')).toHaveLength(
      HOME_CHAT_LIMITS.maxSessions,
    )
  }, 60_000)

  it('caps oversized sessions by dropping the oldest messages', async () => {
    const huge = Array.from({ length: 40 }, (_, i) => convo(`q${i}`, 'z'.repeat(40_000))).flat()
    const saved = await store.save({ messages: huge })
    const raw = await readFile(join(dir, `${saved!.id}.json`), 'utf8')
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(HOME_CHAT_LIMITS.maxSessionBytes + 1024)
    const loaded = await store.get(saved!.id)
    expect(loaded!.messages.at(-1)!.text.startsWith('z')).toBe(true)
    expect(loaded!.messages[0]!.role).toBe('user')
  })

  it('serializes concurrent saves to one file without corruption', async () => {
    const first = await store.save({ messages: convo('start') })
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.save({ id: first!.id, messages: convo('start', `reply ${i}`) }),
      ),
    )
    const loaded = await store.get(first!.id)
    expect(loaded!.messages[1]!.text).toBe('reply 11')
    expect(await store.list()).toHaveLength(1)
  })

  it('writes owner-only files where the platform supports it', async () => {
    const saved = await store.save({ messages: convo('private') })
    if (process.platform === 'win32') return
    const mode = (await stat(join(dir, `${saved!.id}.json`))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  describe('filesystem error handling regressions (Job 04)', () => {
    it('TEST A: a valid session can be deleted normally', async () => {
      const saved = await store.save({ messages: convo('session-a') })
      expect(saved).not.toBeNull()
      const id = saved!.id
      expect(await store.delete(id)).toBe(true)
      expect(await store.get(id)).toBeNull()
      expect(await store.list()).toEqual([])
      const files = await readdir(dir)
      expect(files).not.toContain(`${id}.json`)
    })

    it('TEST B: deleting a session whose file is already absent does not throw an ENOENT exception', async () => {
      const saved = await store.save({ messages: convo('session-b') })
      expect(saved).not.toBeNull()
      const id = saved!.id
      await actualFs.unlink(join(dir, `${id}.json`))
      await expect(store.delete(id)).resolves.toBe(true)
      expect(await store.list()).toEqual([])
    })

    it('TEST C: a real unlink failure propagates', async () => {
      const saved = await store.save({ messages: convo('session-c') })
      expect(saved).not.toBeNull()
      const id = saved!.id
      const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
      mockedUnlink.mockImplementationOnce(async () => {
        throw err
      })
      await expect(store.delete(id)).rejects.toThrow(err)
    })

    it('TEST D: a failed deletion must not be reported as success', async () => {
      const saved = await store.save({ messages: convo('session-d') })
      expect(saved).not.toBeNull()
      const id = saved!.id
      const err = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      mockedUnlink.mockImplementationOnce(async () => {
        throw err
      })
      await expect(store.delete(id)).rejects.toThrow(err)
      const list = await store.list()
      expect(list.some((s) => s.id === id)).toBe(true)
      const files = await readdir(dir)
      expect(files).toContain(`${id}.json`)
    })

    it('TEST E: a successful clear removes all session files', async () => {
      await store.save({ messages: convo('s1') })
      await store.save({ messages: convo('s2') })
      await store.save({ messages: convo('s3') })
      expect(await store.list()).toHaveLength(3)
      const cleared = await store.clear()
      expect(cleared).toBe(3)
      expect(await store.list()).toHaveLength(0)
      const files = await readdir(dir)
      expect(files.filter((name) => name !== 'index.json')).toEqual([])
    })

    it('TEST F: a partial clear failure leaves the remaining files discoverable', async () => {
      const s1 = await store.save({ messages: convo('s1') })
      const s2 = await store.save({ messages: convo('s2') })
      expect(s1).not.toBeNull()
      expect(s2).not.toBeNull()
      const err = Object.assign(new Error('unlink blocked'), { code: 'EBUSY' })
      mockedUnlink.mockImplementation(async (path: any, ...args: any[]) => {
        if (String(path).includes(s2!.id)) {
          throw err
        }
        return (actualFs.unlink as any)(path, ...args)
      })
      await expect(store.clear()).rejects.toThrow(AggregateError)
      const remaining = await store.list()
      expect(remaining.map((s) => s.id)).toEqual([s2!.id])
      const loaded = await store.get(s2!.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.id).toBe(s2!.id)
    })

    it('TEST G: malformed JSON is quarantined', async () => {
      const badId = '12345678-1234-4234-8234-123456789abc'
      const badFile = join(dir, `${badId}.json`)
      await writeFile(badFile, '{"broken": json')
      const result = await store.get(badId)
      expect(result).toBeNull()
      const files = await readdir(dir)
      expect(files).not.toContain(`${badId}.json`)
      const quarantined = files.find((f) => f.startsWith(`${badId}.json.corrupt-`))
      expect(quarantined).toBeDefined()
      expect(await readFile(join(dir, quarantined!), 'utf8')).toBe('{"broken": json')
    })

    it('TEST H: an I/O read error is not treated as malformed JSON', async () => {
      const saved = await store.save({ messages: convo('session-h') })
      expect(saved).not.toBeNull()
      const id = saved!.id
      const ioError = Object.assign(new Error('disk read failed'), { code: 'EIO' })
      mockedReadFile.mockImplementation(async (path: any, ...args: any[]) => {
        if (String(path).includes(id)) {
          throw ioError
        }
        return (actualFs.readFile as any)(path, ...args)
      })
      await expect(store.get(id)).rejects.toThrow(ioError)
      const files = await readdir(dir)
      expect(files).toContain(`${id}.json`)
      expect(files.some((f) => f.startsWith(`${id}.json.corrupt-`))).toBe(false)
    })
  })
})
