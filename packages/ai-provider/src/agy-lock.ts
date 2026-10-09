import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * Machine-wide cap on concurrent `agy` processes. The in-process limiter in agy-cli.ts only counts
 * this process, but the CLI (`genoffice`), a second app instance and a dev build all share one
 * Antigravity account and quota, so they also share this file-based semaphore.
 *
 * It is a set of slot files (`slot-0.lock` ... `slot-<limit-1>.lock`) created exclusively with
 * `wx` in the user data directory. Each holds `{ pid, token, expiresAt }`. A slot whose process is
 * gone, or whose `expiresAt` has passed (pid reuse, a hung holder), is taken over. The semaphore
 * is a politeness cap, not a safety mutex: when the directory cannot be used at all it steps aside
 * (fail open) so a read-only profile never disables the feature.
 */

export const AGY_MACHINE_LIMIT_DEFAULT = 2
export const AGY_MACHINE_LIMIT_MAX = 8
/** a holder is assumed dead this long after its declared run time */
export const AGY_LOCK_GRACE_MS = 30_000
/** how long a queued request waits for a slot before giving up */
export const AGY_LOCK_MAX_WAIT_MS = 5 * 60_000
const POLL_MS = 250
/** a slot file that is still empty after this long was left by a crash mid-write */
const PARTIAL_WRITE_MS = 5_000

export interface AgyMachineLockFs {
  mkdirp(dir: string): Promise<void>
  /** create `path` with `content`; reject with code EEXIST when it exists */
  createExclusive(path: string, content: string): Promise<void>
  read(path: string): Promise<string>
  mtimeMs(path: string): Promise<number>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface AgyMachineLockDeps {
  fs: AgyMachineLockFs
  now(): number
  pid: number
  isAlive(pid: number): boolean
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  random(): string
}

const realFs: AgyMachineLockFs = {
  mkdirp: async (dir) => void (await mkdir(dir, { recursive: true })),
  createExclusive: async (path, content) => {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
  },
  read: (path) => readFile(path, 'utf8'),
  mtimeMs: async (path) => (await stat(path)).mtimeMs,
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReason(): Error {
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  return error
}

const realDeps: AgyMachineLockDeps = {
  fs: realFs,
  now: () => Date.now(),
  pid: process.pid,
  isAlive: processAlive,
  sleep: abortableSleep,
  random: () => randomUUID(),
}

/**
 * The directory shared by every GenOffice process of this user: `GENOFFICE_AGY_LOCK_DIR`, else
 * `agy-locks` inside the shell's user data directory (the same place the CLI finds the settings).
 */
export function agyLockDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.GENOFFICE_AGY_LOCK_DIR?.trim()) return env.GENOFFICE_AGY_LOCK_DIR.trim()
  // the separator follows the target platform, not the machine running this code
  const join = platform === 'win32' ? win32.join : posix.join
  const base =
    env.GENOFFICE_USER_DATA?.trim() ||
    join(
      platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : platform === 'win32'
          ? env.APPDATA || join(home, 'AppData', 'Roaming')
          : env.XDG_CONFIG_HOME || join(home, '.config'),
      'GenOffice',
    )
  return join(base, 'agy-locks')
}

/** `GENOFFICE_AGY_MACHINE_LIMIT`, clamped to 1..8; the default when unset or not a number. */
export function agyMachineLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.GENOFFICE_AGY_MACHINE_LIMIT)
  if (!Number.isFinite(raw) || raw < 1) return AGY_MACHINE_LIMIT_DEFAULT
  return Math.min(AGY_MACHINE_LIMIT_MAX, Math.floor(raw))
}

interface SlotRecord {
  pid: number
  token: string
  expiresAt: number
}

function parseSlot(text: string): SlotRecord | null {
  try {
    const value = JSON.parse(text) as Partial<SlotRecord>
    if (
      typeof value.pid === 'number' &&
      typeof value.token === 'string' &&
      typeof value.expiresAt === 'number'
    )
      return { pid: value.pid, token: value.token, expiresAt: value.expiresAt }
  } catch {
    /* unreadable */
  }
  return null
}

export interface AgyMachineSemaphore {
  /**
   * Wait for a free slot. `holdMs` is how long this holder may legitimately run (its request
   * timeout); past that, other processes may take the slot over. Resolves with the release function.
   * Rejects with an AbortError on abort and with a plain Error after AGY_LOCK_MAX_WAIT_MS.
   */
  acquire(holdMs: number, signal?: AbortSignal): Promise<() => Promise<void>>
}

export interface AgyMachineSemaphoreOptions {
  dir?: string
  limit?: number
  maxWaitMs?: number
  deps?: Partial<AgyMachineLockDeps>
}

const heldFiles = new Set<string>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // best effort: a clean exit gives its slots back at once instead of waiting for the pid check
  process.once('exit', () => {
    for (const file of heldFiles) {
      try {
        rmSync(file, { force: true })
      } catch {
        /* the pid check of the next process recovers it */
      }
    }
  })
}

export function createAgyMachineSemaphore(
  options: AgyMachineSemaphoreOptions = {},
): AgyMachineSemaphore {
  const deps: AgyMachineLockDeps = { ...realDeps, ...options.deps }
  const usingRealFs = deps.fs === realFs
  const maxWaitMs = options.maxWaitMs ?? AGY_LOCK_MAX_WAIT_MS
  // keep the separator style of the directory we were given (a Windows path stays backslashed)
  const slotPath = (dir: string, index: number) =>
    `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}slot-${index}.lock`

  /** True when the slot file may be removed (its holder is gone, expired or never finished writing). */
  async function isStale(file: string): Promise<boolean> {
    let text: string
    try {
      text = await deps.fs.read(file)
    } catch {
      return false // vanished: the next create attempt decides
    }
    const slot = parseSlot(text)
    if (!slot) {
      try {
        return deps.now() - (await deps.fs.mtimeMs(file)) > PARTIAL_WRITE_MS
      } catch {
        return false
      }
    }
    return deps.now() > slot.expiresAt || !deps.isAlive(slot.pid)
  }

  /** Move a stale slot out of the way. Whoever wins the rename owns the cleanup. */
  async function takeOver(file: string): Promise<void> {
    const trash = `${file}.stale-${deps.random()}`
    try {
      await deps.fs.rename(file, trash)
    } catch {
      return // someone else got there first
    }
    // The file may have been replaced by a live holder between our check and the rename.
    let moved: SlotRecord | null = null
    try {
      moved = parseSlot(await deps.fs.read(trash))
    } catch {
      /* gone */
    }
    if (moved && deps.now() <= moved.expiresAt && deps.isAlive(moved.pid)) {
      try {
        // put the live holder's file back unless somebody created a new one meanwhile
        await deps.fs.createExclusive(file, JSON.stringify(moved))
      } catch {
        /* a new slot took its place; the cap may be exceeded by one for a moment */
      }
    }
    await deps.fs.remove(trash).catch(() => undefined)
  }

  return {
    async acquire(holdMs, signal) {
      const dir = options.dir ?? agyLockDir()
      const limit = Math.max(1, Math.floor(options.limit ?? agyMachineLimit()))
      if (signal?.aborted) throw abortReason()
      try {
        await deps.fs.mkdirp(dir)
      } catch {
        return async () => undefined // unusable directory: fail open
      }
      const started = deps.now()
      const token = deps.random()
      for (;;) {
        // each slot is taken over at most once per sweep, so a file that cannot be removed
        // cannot keep this loop spinning
        const triedTakeOver = new Set<number>()
        for (let index = 0; index < limit; index++) {
          const file = slotPath(dir, index)
          const record: SlotRecord = {
            pid: deps.pid,
            token,
            expiresAt: deps.now() + Math.max(1000, holdMs) + AGY_LOCK_GRACE_MS,
          }
          try {
            await deps.fs.createExclusive(file, JSON.stringify(record))
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EEXIST') {
              if (!triedTakeOver.has(index) && (await isStale(file))) {
                triedTakeOver.add(index)
                await takeOver(file)
                index-- // look at the same slot again
              }
              continue
            }
            return async () => undefined // EACCES, EROFS, ...: fail open
          }
          if (usingRealFs) {
            heldFiles.add(file)
            installExitHook()
          }
          let released = false
          return async () => {
            if (released) return
            released = true
            heldFiles.delete(file)
            try {
              const current = parseSlot(await deps.fs.read(file))
              if (current?.token === token) await deps.fs.remove(file)
            } catch {
              /* already gone */
            }
          }
        }
        if (deps.now() - started > maxWaitMs) {
          throw new Error(
            'Other GenOffice windows are using Antigravity right now. Try again in a moment.',
          )
        }
        await deps.sleep(POLL_MS + Math.floor(Math.random() * 100), signal)
      }
    },
  }
}

/** The semaphore every real `runAgy` shares. */
export const agyMachineSemaphore: AgyMachineSemaphore = createAgyMachineSemaphore()
