import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGY_LOCK_GRACE_MS,
  agyLockDir,
  agyMachineLimit,
  createAgyMachineSemaphore,
  type AgyMachineLockDeps,
  type AgyMachineLockFs,
} from '../src/agy-lock'

// ---- an in-memory file system with the same exclusive-create semantics as `open(..., 'wx')` ----

function memoryFs(failMkdir = false, failCreate?: string) {
  const files = new Map<string, { content: string; mtime: number }>()
  let clock = 0
  const fs: AgyMachineLockFs = {
    mkdirp: async () => {
      if (failMkdir) throw Object.assign(new Error('read-only'), { code: 'EROFS' })
    },
    createExclusive: async (path, content) => {
      if (failCreate) throw Object.assign(new Error('denied'), { code: failCreate })
      if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      files.set(path, { content, mtime: clock })
    },
    read: async (path) => {
      const file = files.get(path)
      if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return file.content
    },
    mtimeMs: async (path) => files.get(path)?.mtime ?? 0,
    rename: async (from, to) => {
      const file = files.get(from)
      if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      files.delete(from)
      files.set(to, file)
    },
    remove: async (path) => void files.delete(path),
  }
  return { fs, files, setClock: (ms: number) => (clock = ms) }
}

function fakeDeps(
  fs: AgyMachineLockFs,
  overrides: Partial<AgyMachineLockDeps> = {},
): { deps: Partial<AgyMachineLockDeps>; sleeps: number[]; time: { now: number } } {
  const time = { now: 1_000_000 }
  const sleeps: number[] = []
  let counter = 0
  return {
    time,
    sleeps,
    deps: {
      fs,
      now: () => time.now,
      pid: 100,
      isAlive: () => true,
      random: () => `r${counter++}`,
      // a real (1 ms) pause so other tasks run between polls, but 250 ms of virtual time
      sleep: async (ms) => {
        sleeps.push(ms)
        time.now += ms
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
      ...overrides,
    },
  }
}

const slots = (files: Map<string, unknown>) =>
  [...files.keys()].filter((k) => /slot-\d\.lock$/.test(k)).sort()

describe('machine-wide agy semaphore', () => {
  it('hands out at most `limit` slots and gives a queued request the next free one', async () => {
    const { fs, files } = memoryFs()
    const { deps, time, sleeps } = fakeDeps(fs)
    const sleepsSoFar = () => sleeps.length
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 2, deps })
    const a = await sem.acquire(10_000_000)
    const b = await sem.acquire(10_000_000)
    expect(slots(files)).toEqual(['/locks/slot-0.lock', '/locks/slot-1.lock'])

    let thirdDone = false
    const third = sem.acquire(1000).then((release) => {
      thirdDone = true
      return release
    })
    await new Promise((r) => setImmediate(r))
    expect(thirdDone).toBe(false)
    expect(sleepsSoFar()).toBeGreaterThan(0)

    await a()
    const release = await third
    expect(thirdDone).toBe(true)
    expect(slots(files)).toHaveLength(2)
    await b()
    await release()
    expect(slots(files)).toEqual([])
    expect(time.now).toBeGreaterThan(1_000_000)
  })

  it('takes over a slot whose process is gone (stale-lock recovery by pid)', async () => {
    const { fs, files } = memoryFs()
    files.set('/locks/slot-0.lock', {
      content: JSON.stringify({ pid: 999, token: 'dead', expiresAt: 9_999_999_999 }),
      mtime: 0,
    })
    files.set('/locks/slot-1.lock', {
      content: JSON.stringify({ pid: 100, token: 'live', expiresAt: 9_999_999_999 }),
      mtime: 0,
    })
    const { deps } = fakeDeps(fs, { isAlive: (pid) => pid !== 999 })
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 2, deps })
    const release = await sem.acquire(1000)
    const slot0 = JSON.parse(files.get('/locks/slot-0.lock')!.content)
    expect(slot0).toMatchObject({ pid: 100 })
    expect(slot0.token).not.toBe('dead')
    // the live holder's file is untouched, and no leftover trash files remain
    expect(JSON.parse(files.get('/locks/slot-1.lock')!.content).token).toBe('live')
    expect([...files.keys()].filter((k) => k.includes('.stale-'))).toEqual([])
    await release()
  })

  it('takes over a slot whose declared run time has passed even if the pid is alive (pid reuse)', async () => {
    const { fs, files } = memoryFs()
    const { deps, time } = fakeDeps(fs)
    files.set('/locks/slot-0.lock', {
      content: JSON.stringify({ pid: 321, token: 'old', expiresAt: time.now - 1 }),
      mtime: 0,
    })
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps })
    await sem.acquire(1000)
    expect(JSON.parse(files.get('/locks/slot-0.lock')!.content).pid).toBe(100)
  })

  it('records an expiry of hold time plus a grace period', async () => {
    const { fs, files } = memoryFs()
    const { deps, time } = fakeDeps(fs)
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps })
    await sem.acquire(240_000)
    expect(JSON.parse(files.get('/locks/slot-0.lock')!.content).expiresAt).toBe(
      time.now + 240_000 + AGY_LOCK_GRACE_MS,
    )
  })

  it('treats a slot file left empty by a crash mid-write as stale only after a few seconds', async () => {
    const { fs, files, setClock } = memoryFs()
    const { deps, time } = fakeDeps(fs)
    files.set('/locks/slot-0.lock', { content: '', mtime: time.now })
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps, maxWaitMs: 60_000 })
    const release = await sem.acquire(1000) // waits (fresh), then takes over once it is old enough
    expect(JSON.parse(files.get('/locks/slot-0.lock')!.content).pid).toBe(100)
    setClock(0)
    await release()
  })

  it("a release only removes the holder's own file", async () => {
    const { fs, files } = memoryFs()
    const { deps } = fakeDeps(fs)
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps })
    const release = await sem.acquire(1000)
    files.set('/locks/slot-0.lock', {
      content: JSON.stringify({ pid: 5, token: 'someone-else', expiresAt: 9_999_999_999 }),
      mtime: 0,
    })
    await release()
    expect(files.has('/locks/slot-0.lock')).toBe(true)
    await release() // idempotent
  })

  it('leaves the queue promptly when aborted while waiting', async () => {
    const { fs } = memoryFs()
    const ctrl = new AbortController()
    const { deps } = fakeDeps(fs, {
      sleep: async (_ms, signal) => {
        await new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
          ),
        )
      },
    })
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps })
    await sem.acquire(1000)
    const waiting = sem.acquire(1000, ctrl.signal)
    waiting.catch(() => undefined)
    await new Promise((r) => setImmediate(r))
    ctrl.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    ctrl.abort()
    await expect(sem.acquire(1000, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('gives up with a readable error after the maximum wait', async () => {
    const { fs } = memoryFs()
    const { deps } = fakeDeps(fs)
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps, maxWaitMs: 2000 })
    await sem.acquire(10_000_000)
    await expect(sem.acquire(1000)).rejects.toThrow(/Other GenOffice windows are using Antigravity/)
  })

  it('steps aside (fails open) when the lock directory cannot be used', async () => {
    for (const fs of [memoryFs(true).fs, memoryFs(false, 'EACCES').fs]) {
      const { deps } = fakeDeps(fs)
      const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps })
      const release = await sem.acquire(1000)
      await expect(release()).resolves.toBeUndefined()
      // and it does not hold anything back: a second request goes straight through
      await sem.acquire(1000)
    }
  })

  it('does not spin forever on a stale slot it cannot remove', async () => {
    const { fs, files } = memoryFs()
    files.set('/locks/slot-0.lock', {
      content: JSON.stringify({ pid: 999, token: 'dead', expiresAt: 9_999_999_999 }),
      mtime: 0,
    })
    const stuck: AgyMachineLockFs = {
      ...fs,
      rename: async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      },
    }
    const { deps } = fakeDeps(stuck, { isAlive: () => false })
    const sem = createAgyMachineSemaphore({ dir: '/locks', limit: 1, deps, maxWaitMs: 1500 })
    await expect(sem.acquire(1000)).rejects.toThrow(/Other GenOffice windows/)
  })
})

describe('lock directory and limit settings', () => {
  it('lives in the shell user-data directory, like the settings the CLI reads', () => {
    expect(agyLockDir({}, 'darwin', '/Users/u')).toBe(
      '/Users/u/Library/Application Support/GenOffice/agy-locks',
    )
    expect(agyLockDir({}, 'linux', '/home/u')).toBe('/home/u/.config/GenOffice/agy-locks')
    expect(agyLockDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u')).toBe('/x/GenOffice/agy-locks')
    expect(agyLockDir({ GENOFFICE_USER_DATA: '/data' }, 'linux', '/home/u')).toBe('/data/agy-locks')
    expect(agyLockDir({ GENOFFICE_AGY_LOCK_DIR: '/only/here' }, 'linux', '/home/u')).toBe(
      '/only/here',
    )
  })

  it('defaults to two machine-wide slots, clamped between 1 and 8', () => {
    expect(agyMachineLimit({})).toBe(2)
    expect(agyMachineLimit({ GENOFFICE_AGY_MACHINE_LIMIT: '4' })).toBe(4)
    expect(agyMachineLimit({ GENOFFICE_AGY_MACHINE_LIMIT: '99' })).toBe(8)
    expect(agyMachineLimit({ GENOFFICE_AGY_MACHINE_LIMIT: '0' })).toBe(2)
    expect(agyMachineLimit({ GENOFFICE_AGY_MACHINE_LIMIT: 'lots' })).toBe(2)
  })
})

describe('on the real file system (two semaphores stand in for two processes)', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-lock-'))
    dirs.push(dir)
    return dir
  }

  it('shares the limit across instances and cleans up its files', async () => {
    const dir = tmp()
    const one = createAgyMachineSemaphore({ dir, limit: 2 })
    const two = createAgyMachineSemaphore({ dir, limit: 2 })
    const a = await one.acquire(5000)
    const b = await two.acquire(5000)
    expect(readdirSync(dir).sort()).toEqual(['slot-0.lock', 'slot-1.lock'])
    expect(JSON.parse(readFileSync(join(dir, 'slot-0.lock'), 'utf8')).pid).toBe(process.pid)

    let got = false
    const third = one.acquire(5000).then((release) => {
      got = true
      return release
    })
    await new Promise((r) => setTimeout(r, 400))
    expect(got).toBe(false)
    await a()
    const release = await third
    expect(got).toBe(true)
    await b()
    await release()
    expect(readdirSync(dir)).toEqual([])
  })

  it('recovers a slot left behind by a process that no longer exists', async () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'slot-0.lock'),
      JSON.stringify({ pid: 2_147_000_000, token: 'ghost', expiresAt: Date.now() + 3_600_000 }),
    )
    const sem = createAgyMachineSemaphore({ dir, limit: 1 })
    const release = await sem.acquire(1000)
    expect(JSON.parse(readFileSync(join(dir, 'slot-0.lock'), 'utf8')).pid).toBe(process.pid)
    await release()
    expect(readdirSync(dir)).toEqual([])
  })
})
