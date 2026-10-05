import { EventEmitter } from 'node:events'
import { constants } from 'node:os'
import type { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coolDownMs, withBackgroundBudget } from '../src/main/document-memory/cpu-budget'
import { createIndexProcess } from '../src/main/document-memory/process-worker'
import { childFreeMemMB, ortSessionOptions } from '../src/main/fork/embedding-ort'
import { createSessionKeeper } from '../src/main/fork/embedding-session'
import { attachChildToPolicy, osPriorityFor } from '../src/main/fork/indexing-child-policy'
import {
  publishIndexingPolicy,
  resetIndexingPolicyBus,
  type PublishedPolicy,
} from '../src/main/fork/indexing-policy-bus'
import {
  applyPolicyMessage,
  isPolicyMessage,
  resetWorkerPolicy,
  workerPolicy,
} from '../src/main/fork/indexing-worker-policy'

function policy(patch: Partial<PublishedPolicy> = {}): PublishedPolicy {
  return {
    paused: false,
    threads: 2,
    cpuShare: 0.5,
    priority: 'below-normal',
    tier: 'active',
    reason: 'test',
    onBattery: false,
    ...patch,
  }
}

beforeEach(() => {
  resetIndexingPolicyBus()
  resetWorkerPolicy()
})

afterEach(() => {
  resetIndexingPolicyBus()
  resetWorkerPolicy()
})

describe('worker policy message', () => {
  it('recognises policy messages and never mistakes a request for one', () => {
    expect(isPolicyMessage({ type: 'policy', threads: 2, cpuShare: 0.5 })).toBe(true)
    expect(isPolicyMessage({ id: 1, type: 'policy' })).toBe(false)
    expect(isPolicyMessage({ id: 1, type: 'embed' })).toBe(false)
    expect(isPolicyMessage(null)).toBe(false)
    expect(isPolicyMessage('policy')).toBe(false)
  })

  it('starts with the historic behaviour: one thread, 35% of a core', () => {
    expect(workerPolicy).toEqual({ threads: 1, cpuShare: 0.35 })
  })

  it('applies and sanitises values', () => {
    applyPolicyMessage({ type: 'policy', threads: 4.9, cpuShare: 1 })
    expect(workerPolicy).toEqual({ threads: 4, cpuShare: 1 })
    applyPolicyMessage({ type: 'policy', threads: 999, cpuShare: 0 })
    expect(workerPolicy.threads).toBe(16)
    expect(workerPolicy.cpuShare).toBeGreaterThan(0)
    applyPolicyMessage({ type: 'policy', threads: Number.NaN, cpuShare: 5 } as never)
    expect(workerPolicy.threads).toBe(16)
    expect(workerPolicy.cpuShare).toBe(1)
    applyPolicyMessage({ type: 'policy', threads: -3, cpuShare: 'x' } as never)
    expect(workerPolicy.threads).toBe(1)
  })
})

describe('duty cycle', () => {
  it('derives the cool-down from the share', () => {
    expect(coolDownMs(100, 0.35)).toBe(186)
    expect(coolDownMs(100, 0.5)).toBe(100)
    expect(coolDownMs(100, 0.25)).toBe(300)
    expect(coolDownMs(0, 0.5)).toBe(10)
    expect(coolDownMs(100000, 0.1)).toBe(2000)
  })
  it('does not sleep when uncapped', () => {
    expect(coolDownMs(500, 1)).toBe(0)
  })

  it('withBackgroundBudget follows the live policy', async () => {
    const burn = async () => {
      const stop = performance.now() + 30
      while (performance.now() < stop) {
        /* busy */
      }
    }
    applyPolicyMessage({ type: 'policy', threads: 1, cpuShare: 1 })
    let started = performance.now()
    await withBackgroundBudget(burn)
    expect(performance.now() - started).toBeLessThan(90)
    applyPolicyMessage({ type: 'policy', threads: 1, cpuShare: 0.25 })
    started = performance.now()
    await withBackgroundBudget(burn)
    expect(performance.now() - started).toBeGreaterThanOrEqual(110)
  })
})

describe('OS priority', () => {
  it('maps the idle class on Windows only', () => {
    expect(osPriorityFor('idle', 'win32')).toBe(constants.priority.PRIORITY_LOW)
    expect(osPriorityFor('below-normal', 'win32')).toBe(constants.priority.PRIORITY_BELOW_NORMAL)
  })
  it('never strands a POSIX child at a nice value it cannot lower again', () => {
    for (const platform of ['darwin', 'linux'] as const)
      expect(osPriorityFor('idle', platform)).toBe(constants.priority.PRIORITY_BELOW_NORMAL)
  })
})

describe('attachChildToPolicy', () => {
  function fakeChild(platform: NodeJS.Platform = 'win32') {
    const sent: unknown[] = []
    const priorities: [number, number][] = []
    let connected = true
    return {
      sent,
      priorities,
      disconnect: () => (connected = false),
      control: {
        pid: 4242,
        platform,
        connected: () => connected,
        send: (message: unknown) => sent.push(message),
        setPriority: (pid: number, priority: number) => priorities.push([pid, priority]),
      },
    }
  }

  it('pushes the current policy immediately, then every change', () => {
    publishIndexingPolicy(policy())
    const child = fakeChild()
    const detach = attachChildToPolicy(child.control as never)
    expect(child.sent).toEqual([{ type: 'policy', threads: 2, cpuShare: 0.5 }])
    publishIndexingPolicy(policy({ threads: 4, cpuShare: 1, tier: 'idle' }))
    expect(child.sent.at(-1)).toEqual({ type: 'policy', threads: 4, cpuShare: 1 })
    detach()
    publishIndexingPolicy(policy({ threads: 1, cpuShare: 0.3 }))
    expect(child.sent).toHaveLength(2)
  })

  it('moves a Windows child between idle and below-normal and skips no-op changes', () => {
    const child = fakeChild('win32')
    attachChildToPolicy(child.control as never)
    publishIndexingPolicy(policy({ priority: 'idle', onBattery: true, tier: 'battery' }))
    publishIndexingPolicy(
      policy({ priority: 'idle', threads: 1, onBattery: true, tier: 'battery' }),
    )
    publishIndexingPolicy(policy())
    expect(child.priorities).toEqual([
      [4242, constants.priority.PRIORITY_LOW],
      [4242, constants.priority.PRIORITY_BELOW_NORMAL],
    ])
  })

  it('keeps a POSIX child at below-normal', () => {
    const child = fakeChild('linux')
    attachChildToPolicy(child.control as never)
    publishIndexingPolicy(policy({ priority: 'idle', tier: 'battery' }))
    publishIndexingPolicy(policy())
    expect(child.priorities).toEqual([[4242, constants.priority.PRIORITY_BELOW_NORMAL]])
  })

  it('a paused policy still reaches the child (threads and share unchanged for a fast resume)', () => {
    const child = fakeChild()
    attachChildToPolicy(child.control as never)
    publishIndexingPolicy(
      policy({ paused: true, pauseReason: 'locked', cpuShare: 0, tier: 'paused' }),
    )
    expect(child.sent).toHaveLength(1)
  })

  it('does not send to a disconnected child and never throws', () => {
    const child = fakeChild()
    child.control.setPriority = () => {
      throw new Error('EPERM')
    }
    attachChildToPolicy(child.control as never)
    child.disconnect()
    expect(() => publishIndexingPolicy(policy({ threads: 3 }))).not.toThrow()
    expect(child.sent).toHaveLength(0)
    const throwing = fakeChild()
    throwing.control.send = () => {
      throw new Error('channel closed')
    }
    attachChildToPolicy(throwing.control as never)
    expect(() => publishIndexingPolicy(policy({ threads: 5 }))).not.toThrow()
  })
})

describe('createIndexProcess with a fake child', () => {
  it('attaches the policy on spawn and detaches on exit', () => {
    publishIndexingPolicy(policy({ threads: 3, cpuShare: 0.6 }))
    const child = Object.assign(new EventEmitter(), {
      pid: 777,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) =>
        callback?.(null),
      ),
      kill: vi.fn(),
    })
    const fakeSpawn = vi.fn(() => child) as unknown as typeof spawn
    const worker = createIndexProcess('worker.cjs', { cacheDir: 'c', dbPath: 'd' }, fakeSpawn)
    child.emit('spawn')
    expect(child.send).toHaveBeenCalledWith(
      { type: 'policy', threads: 3, cpuShare: 0.6 },
      expect.any(Function),
    )
    publishIndexingPolicy(policy({ threads: 1, cpuShare: 0.3 }))
    expect(child.send).toHaveBeenCalledTimes(2)
    child.emit('exit', 0)
    publishIndexingPolicy(policy({ threads: 6, cpuShare: 1 }))
    expect(child.send).toHaveBeenCalledTimes(2)
    expect(worker).toBeTruthy()
  })

  it('terminates gracefully with SIGTERM when child exits within grace period', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 777,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn((signal?: string) => {
        if (signal === 'SIGTERM') {
          queueMicrotask(() => {
            child.exitCode = 0
            child.emit('exit', 0)
          })
        }
      }),
    })
    const fakeSpawn = vi.fn(() => child) as unknown as typeof spawn
    const worker = createIndexProcess('worker.cjs', { cacheDir: 'c', dbPath: 'd' }, fakeSpawn)

    const code = await worker.terminate(1000)
    expect(code).toBe(0)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('escalates to SIGKILL if child does not exit before graceful timeout', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 777,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn((signal?: string) => {
        if (signal === 'SIGKILL') {
          child.exitCode = 137
          child.emit('exit', 137)
        }
      }),
    })
    const fakeSpawn = vi.fn(() => child) as unknown as typeof spawn
    const worker = createIndexProcess('worker.cjs', { cacheDir: 'c', dbPath: 'd' }, fakeSpawn)

    const code = await worker.terminate(20)
    expect(code).toBe(137)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('returns exitCode immediately without signaling if child is already dead', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 777,
      connected: false,
      exitCode: 42,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(),
    })
    const fakeSpawn = vi.fn(() => child) as unknown as typeof spawn
    const worker = createIndexProcess('worker.cjs', { cacheDir: 'c', dbPath: 'd' }, fakeSpawn)

    const code = await worker.terminate()
    expect(code).toBe(42)
    expect(child.kill).not.toHaveBeenCalled()
  })
})

describe('session keeper (thread changes between batches)', () => {
  function keeper(options: { free?: number; failCreate?: boolean } = {}) {
    let now = 100_000
    let wanted = 1
    let free = options.free ?? 8000
    const created: number[] = []
    const released: string[] = []
    let counter = 0
    const k = createSessionKeeper('s0', 1, {
      desiredThreads: () => wanted,
      create: async (threads) => {
        created.push(threads)
        if (options.failCreate) throw new Error('out of memory')
        return `s${++counter}`
      },
      release: (session) => {
        released.push(session)
      },
      freeMemMB: () => free,
      now: () => now,
    })
    return {
      k,
      created,
      released,
      want: (n: number) => (wanted = n),
      tick: (ms: number) => (now += ms),
      setFree: (n: number) => (free = n),
    }
  }

  it('keeps the session while the thread count is unchanged', async () => {
    const t = keeper()
    await t.k.align()
    expect(t.created).toEqual([])
    expect(t.k.current()).toBe('s0')
  })

  it('swaps only after the new session exists, then releases the old one', async () => {
    const t = keeper()
    t.tick(60_000)
    t.want(4)
    const aligning = t.k.align()
    expect(t.k.current()).toBe('s0') // still the old one while the new one is loading
    await aligning
    expect(t.k.current()).toBe('s1')
    expect(t.k.threads()).toBe(4)
    expect(t.released).toEqual(['s0'])
  })

  it('rate limits ramp-up but never delays ramp-down', async () => {
    const t = keeper()
    t.want(4)
    await t.k.align() // right after creation: too early to ramp up
    expect(t.created).toEqual([])
    t.tick(31_000)
    await t.k.align()
    expect(t.created).toEqual([4])
    t.want(1) // the user is back: immediate
    await t.k.align()
    expect(t.created).toEqual([4, 1])
  })

  it('skips the rebuild when memory is tight and keeps working', async () => {
    const t = keeper({ free: 900 })
    t.tick(60_000)
    t.want(4)
    await t.k.align()
    expect(t.created).toEqual([])
    expect(t.k.current()).toBe('s0')
    t.setFree(4000)
    await t.k.align()
    expect(t.created).toEqual([4])
  })

  it('keeps the old session and backs off when creating the new one fails', async () => {
    const t = keeper({ failCreate: true })
    t.tick(60_000)
    t.want(4)
    await t.k.align()
    expect(t.k.current()).toBe('s0')
    expect(t.released).toEqual([])
    await t.k.align()
    expect(t.created).toHaveLength(1) // backing off
    t.tick(31_000)
    await t.k.align()
    expect(t.created).toHaveLength(2)
  })

  it('does not start a second rebuild while one is running', async () => {
    const t = keeper()
    t.tick(60_000)
    t.want(4)
    await Promise.all([t.k.align(), t.k.align()])
    expect(t.created).toEqual([4])
  })
})

describe('onnxruntime options', () => {
  it('uses the requested intra-op threads with one inter-op thread and no spinning', () => {
    const options = ortSessionOptions(3)
    expect(options.intraOpNumThreads).toBe(3)
    expect(options.interOpNumThreads).toBe(1)
    expect(options.executionMode).toBe('sequential')
    expect(JSON.stringify(options.extra)).toContain('allow_spinning')
  })
  it('does not let macOS os.freemem() block rebuilds', () => {
    expect(childFreeMemMB('darwin', () => 100 * 1024 * 1024)).toBe(Number.POSITIVE_INFINITY)
    expect(childFreeMemMB('linux', () => 2048 * 1024 * 1024)).toBe(2048)
    expect(childFreeMemMB('win32', () => 512 * 1024 * 1024)).toBe(512)
  })
})
