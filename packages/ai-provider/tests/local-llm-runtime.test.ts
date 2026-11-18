import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  createLocalLlmRuntime,
  LocalLlmError,
  LOCAL_MODEL_NOT_INSTALLED_MESSAGE,
  llamaServerArgs,
  resolveLocalLaunch,
  type LocalLlmRuntimeDeps,
} from '../src/local-llm/llama-server-runtime'
import { LOCAL_DEFAULT_CTX } from '../src/local-llm/local-meta'
import type { AiProviderConfig } from '../src/types'

const MODEL = '/models/LFM3-VL-2B-Q4_K_M.gguf'
/** a downloaded or chosen model, verified by the shell's manager: any file name */
const MANAGED = '/userData/local-models/LiquidAI/LFM3-VL-2B-GGUF/rev/my-copy.bin'
const BINARY = '/opt/llama/llama-server'
const CONFIG: AiProviderConfig = { apiKey: '', model: 'lfm3-vl-2b-q4_k_m', cliPath: BINARY }

class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
  crash(code = 1): void {
    this.emit('exit', code, null)
  }
}

interface Harness {
  deps: LocalLlmRuntimeDeps
  spawned: Array<{ command: string; args: string[]; child: FakeChild }>
  /** statuses returned by /health in order; the last one repeats */
  health: number[]
  env: Record<string, string | undefined>
  /** what the model manager reports (setLocalModelResolver); null = nothing installed */
  managed: string | null
  /** called once per spawn before it returns, to script the child */
  onSpawn?: (child: FakeChild) => void
}

function harness(overrides: Partial<LocalLlmRuntimeDeps> = {}): Harness {
  let clock = 0
  let port = 40000
  const h: Harness = {
    spawned: [],
    health: [200],
    env: { GENOFFICE_LOCAL_MODEL_PATH: MODEL },
    managed: null,
    deps: undefined as unknown as LocalLlmRuntimeDeps,
  }
  h.deps = {
    spawn: (command, args) => {
      const child = new FakeChild()
      h.spawned.push({ command, args, child })
      h.onSpawn?.(child)
      return child as unknown as ChildProcess
    },
    getStatus: async () => (h.health.length > 1 ? h.health.shift()! : h.health[0]!),
    freePort: async () => ++port,
    isFile: (path) => path === MODEL || path === BINARY || path === MANAGED,
    env: () => h.env,
    modelPath: () => h.managed,
    token: () => 'secret-token',
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    startupTimeoutMs: 5_000,
    ...overrides,
  }
  return h
}

describe('resolveLocalLaunch', () => {
  const deps = (env: Record<string, string | undefined>, managed: string | null = null) => ({
    env: () => env,
    isFile: (path: string) => path === MODEL || path === BINARY || path === MANAGED,
    modelPath: () => managed,
  })

  it('takes the binary from cliPath and the model from the environment', () => {
    expect(resolveLocalLaunch(CONFIG, deps({ GENOFFICE_LOCAL_MODEL_PATH: MODEL }))).toEqual({
      binary: BINARY,
      model: MODEL,
      ctx: LOCAL_DEFAULT_CTX,
    })
  })

  it('defaults to a 64K context window', () => {
    expect(LOCAL_DEFAULT_CTX).toBe(65536)
  })

  it('lets GENOFFICE_LOCAL_CTX override the default, within bounds', () => {
    const ctxFor = (value: string) =>
      resolveLocalLaunch(CONFIG, deps({ GENOFFICE_LOCAL_MODEL_PATH: MODEL, GENOFFICE_LOCAL_CTX: value })).ctx
    expect(ctxFor('16384')).toBe(16384)
    expect(ctxFor('512')).toBe(2048)
    expect(ctxFor('1000000')).toBe(131072)
    expect(ctxFor('not-a-number')).toBe(LOCAL_DEFAULT_CTX)
  })

  it('falls back to GENOFFICE_LLAMA_SERVER_PATH and reads ctx / threads', () => {
    const launch = resolveLocalLaunch(
      { apiKey: '', model: 'x' },
      deps({
        GENOFFICE_LLAMA_SERVER_PATH: BINARY,
        GENOFFICE_LOCAL_MODEL_PATH: MODEL,
        GENOFFICE_LOCAL_CTX: '8192',
        GENOFFICE_LOCAL_THREADS: '6',
      }),
    )
    expect(launch).toEqual({ binary: BINARY, model: MODEL, ctx: 8192, threads: 6 })
  })

  it('rejects a missing binary, a missing model and any other model file', () => {
    expect(() =>
      resolveLocalLaunch({ apiKey: '', model: 'x' }, deps({ GENOFFICE_LOCAL_MODEL_PATH: MODEL })),
    ).toThrow(LocalLlmError)
    expect(() => resolveLocalLaunch(CONFIG, deps({}))).toThrow(LOCAL_MODEL_NOT_INSTALLED_MESSAGE)
    expect(() =>
      resolveLocalLaunch(CONFIG, deps({ GENOFFICE_LOCAL_MODEL_PATH: '/models/other.gguf' })),
    ).toThrow(/Only LFM3-VL-2B-Q4_K_M\.gguf/)
    expect(() =>
      resolveLocalLaunch(
        { ...CONFIG, cliPath: '/nowhere/llama-server' },
        deps({ GENOFFICE_LOCAL_MODEL_PATH: MODEL }),
      ),
    ).toThrow(/not found/)
  })

  describe('model source order', () => {
    it('uses the verified model from the model manager when there is no override', () => {
      expect(resolveLocalLaunch(CONFIG, deps({}, MANAGED)).model).toBe(MANAGED)
    })

    it('accepts any name for the managed model (it was verified by size and SHA-256)', () => {
      expect(MANAGED).not.toMatch(/LFM3-VL-2B-Q4_K_M\.gguf$/)
      expect(() => resolveLocalLaunch(CONFIG, deps({}, MANAGED))).not.toThrow()
    })

    it('lets GENOFFICE_LOCAL_MODEL_PATH override the managed model', () => {
      expect(resolveLocalLaunch(CONFIG, deps({ GENOFFICE_LOCAL_MODEL_PATH: MODEL }, MANAGED)).model).toBe(
        MODEL,
      )
    })

    it('keeps checking the override by name even when a managed model exists', () => {
      expect(() =>
        resolveLocalLaunch(CONFIG, deps({ GENOFFICE_LOCAL_MODEL_PATH: '/models/other.gguf' }, MANAGED)),
      ).toThrow(/Only LFM3-VL-2B-Q4_K_M\.gguf/)
    })

    it('reports "not installed" when nothing is available or the managed file has gone', () => {
      expect(() => resolveLocalLaunch(CONFIG, deps({}, null))).toThrow(LOCAL_MODEL_NOT_INSTALLED_MESSAGE)
      expect(() => resolveLocalLaunch(CONFIG, deps({}, '/gone/model.gguf'))).toThrow(
        LOCAL_MODEL_NOT_INSTALLED_MESSAGE,
      )
      expect(LOCAL_MODEL_NOT_INSTALLED_MESSAGE).toContain('not installed')
    })
  })
})

describe('llamaServerArgs', () => {
  it('is text-only, loopback-bound and keyed', () => {
    const args = llamaServerArgs({ binary: BINARY, model: MODEL, ctx: 16384 }, 4321, 'tok')
    expect(args).not.toContain('--mmproj')
    expect(args.join(' ')).toContain('-m /models/LFM3-VL-2B-Q4_K_M.gguf')
    expect(args.join(' ')).toContain('--host 127.0.0.1 --port 4321 --api-key tok')
    expect(args.join(' ')).toContain('-c 16384 -np 1')
    expect(args).toContain('--jinja')
  })
})

describe('createLocalLlmRuntime', () => {
  it('starts llama-server and resolves once /health answers 200', async () => {
    const h = harness()
    h.health = [503, 503, 200]
    const runtime = createLocalLlmRuntime(h.deps)
    const endpoint = await runtime.ensure(CONFIG)
    expect(endpoint).toEqual({ baseUrl: 'http://127.0.0.1:40001/v1', token: 'secret-token' })
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.command).toBe(BINARY)
    expect(h.spawned[0]!.args).not.toContain('--mmproj')
    // no GENOFFICE_LOCAL_CTX in the environment: the server gets the 64K default
    expect(h.spawned[0]!.args.join(' ')).toContain('-c 65536 -np 1')
  })

  it('reuses the running server and shares one start between concurrent callers', async () => {
    const h = harness()
    const runtime = createLocalLlmRuntime(h.deps)
    const [a, b] = await Promise.all([runtime.ensure(CONFIG), runtime.ensure(CONFIG)])
    expect(a).toEqual(b)
    await runtime.ensure(CONFIG)
    expect(h.spawned).toHaveLength(1)
  })

  it('reports an exit before readiness with the stderr tail', async () => {
    const h = harness()
    h.health = [503]
    h.onSpawn = (child) =>
      queueMicrotask(() => {
        child.stderr.emit('data', 'error: unknown model architecture: lfm3')
        child.crash(1)
      })
    const runtime = createLocalLlmRuntime(h.deps)
    await expect(runtime.ensure(CONFIG)).rejects.toThrow(/exited before it was ready[\s\S]*lfm3/)
  })

  it('gives up and kills the process when the model never becomes ready', async () => {
    const h = harness()
    h.health = [503]
    const runtime = createLocalLlmRuntime(h.deps)
    await expect(runtime.ensure(CONFIG)).rejects.toThrow(/did not become ready/)
    expect(h.spawned[0]!.child.killed).toBe(true)
  })

  it('reports a spawn failure', async () => {
    const h = harness()
    h.health = [503]
    h.onSpawn = (child) =>
      queueMicrotask(() => child.emit('error', new Error('spawn llama-server ENOENT')))
    const runtime = createLocalLlmRuntime(h.deps)
    await expect(runtime.ensure(CONFIG)).rejects.toThrow(/Could not start llama-server: .*ENOENT/)
  })

  it('starts a fresh process after a crash', async () => {
    const h = harness()
    const runtime = createLocalLlmRuntime(h.deps)
    await runtime.ensure(CONFIG)
    h.spawned[0]!.child.crash(139)
    await runtime.ensure(CONFIG)
    expect(h.spawned).toHaveLength(2)
  })

  it('restarts when the launch settings change', async () => {
    const h = harness()
    const runtime = createLocalLlmRuntime(h.deps)
    await runtime.ensure(CONFIG)
    h.env.GENOFFICE_LOCAL_CTX = '8192'
    await runtime.ensure(CONFIG)
    expect(h.spawned).toHaveLength(2)
    expect(h.spawned[0]!.child.killed).toBe(true)
    expect(h.spawned[1]!.args.join(' ')).toContain('-c 8192')
  })

  it('starts from the managed model, reports a removed one, and restarts for a new one', async () => {
    const h = harness()
    h.env = {}
    h.managed = MANAGED
    const runtime = createLocalLlmRuntime(h.deps)
    await runtime.ensure(CONFIG)
    expect(h.spawned[0]!.args.join(' ')).toContain(`-m ${MANAGED}`)

    h.managed = null // deleted in Settings
    await expect(runtime.ensure(CONFIG)).rejects.toThrow(LOCAL_MODEL_NOT_INSTALLED_MESSAGE)

    h.managed = MODEL // another verified file chosen
    await runtime.ensure(CONFIG)
    expect(h.spawned).toHaveLength(2)
    expect(h.spawned[0]!.child.killed).toBe(true)
    expect(h.spawned[1]!.args.join(' ')).toContain(`-m ${MODEL}`)
  })

  it('stops the process on shutdown and is safe to call twice', async () => {
    const h = harness()
    const runtime = createLocalLlmRuntime(h.deps)
    await runtime.ensure(CONFIG)
    runtime.shutdown()
    runtime.shutdown()
    expect(h.spawned[0]!.child.killed).toBe(true)
  })

  it('lets a caller give up without stopping the shared start', async () => {
    const h = harness()
    h.health = [503, 503, 503, 200]
    const runtime = createLocalLlmRuntime(h.deps)
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.ensure(CONFIG, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await runtime.ensure(CONFIG)
    expect(h.spawned).toHaveLength(1)
  })
})
