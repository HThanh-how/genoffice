import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import type { AiProviderConfig } from '../types'
import { LOCAL_DEFAULT_CTX, LOCAL_MODEL_FILE } from './local-meta'

/**
 * The managed llama-server process behind the `local` provider. Node-only.
 *
 * Text generation only, one model (LFM3-VL-2B-Q4_K_M), no mmproj. The binary comes from the
 * provider's cliPath or GENOFFICE_LLAMA_SERVER_PATH. The model file is, in this order:
 *   1. GENOFFICE_LOCAL_MODEL_PATH, a developer override (must be named LFM3-VL-2B-Q4_K_M.gguf);
 *   2. the model the app downloaded or the person chose, handed in by setLocalModelResolver (the
 *      shell's local model manager has already verified its size and SHA-256, so any name works);
 *   3. otherwise the request fails with LOCAL_MODEL_NOT_INSTALLED_MESSAGE.
 * The server binds 127.0.0.1 on a free port and requires a random per-process API key, so nothing
 * else on the machine can drive it.
 *
 * The context window is LOCAL_DEFAULT_CTX (65536, see local-meta.ts for its RAM and latency cost)
 * unless GENOFFICE_LOCAL_CTX names another size, which is clamped to 2048..131072.
 *
 * One process serves every caller. It starts on first use, is ready once GET /health answers 200
 * (llama-server answers 503 while the model loads), is restarted on the next call after a crash,
 * and is replaced when the launch settings change.
 */

export const LLAMA_SERVER_PATH_ENV = 'GENOFFICE_LLAMA_SERVER_PATH'
export const LOCAL_MODEL_PATH_ENV = 'GENOFFICE_LOCAL_MODEL_PATH'
export const LOCAL_CTX_ENV = 'GENOFFICE_LOCAL_CTX'
export const LOCAL_THREADS_ENV = 'GENOFFICE_LOCAL_THREADS'

/** How long the model may take to load before the start counts as failed. */
export const LOCAL_STARTUP_TIMEOUT_MS = 120_000
const HEALTH_POLL_MS = 250
const HEALTH_REQUEST_TIMEOUT_MS = 2_000
const STDERR_TAIL_CHARS = 8_192
const MIN_CTX = 2_048
const MAX_CTX = 131_072

/** A start-up or configuration failure with a message that can be shown as-is. */
export class LocalLlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalLlmError'
  }
}

/** Shown when neither the developer override nor a downloaded / chosen model is available. */
export const LOCAL_MODEL_NOT_INSTALLED_MESSAGE =
  'The local AI model is not installed. Download it, or choose an existing LFM3-VL-2B-Q4_K_M file, in Settings → AI Model → Local.'

/**
 * Where the verified local model file is, or null when none is ready. The shell registers its
 * local model manager here (main-process start-up); this package never imports the shell.
 */
let localModelResolver: (() => string | null) | null = null

/** Registers (or, with null, removes) the source of the verified local model path. */
export function setLocalModelResolver(resolver: (() => string | null) | null): void {
  localModelResolver = resolver
}

export interface LocalLlmLaunch {
  binary: string
  model: string
  ctx: number
  threads?: number
}

export interface LocalLlmEndpoint {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:51234/v1 */
  baseUrl: string
  /** bearer token the server was started with */
  token: string
}

export interface LocalLlmRuntimeDeps {
  spawn(command: string, args: string[]): ChildProcess
  /** GET with a header; resolves with the HTTP status, rejects on a network error */
  getStatus(url: string, headers: Record<string, string>): Promise<number>
  freePort(): Promise<number>
  isFile(path: string): boolean
  env(): Record<string, string | undefined>
  /** the verified model path from the shell's model manager, or null (see setLocalModelResolver) */
  modelPath(): string | null
  token(): string
  sleep(ms: number): Promise<void>
  now(): number
  startupTimeoutMs: number
}

export interface LocalLlmRuntime {
  ensure(config: AiProviderConfig, signal?: AbortSignal): Promise<LocalLlmEndpoint>
  shutdown(): void
}

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined
  const n = Number(raw.trim())
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function hasPathSeparator(value: string): boolean {
  return /[/\\]/.test(value)
}

/**
 * The model file to load: the developer override first (checked by name, as it is not verified),
 * then the path the model manager verified by size and SHA-256 (any name). Throws LocalLlmError.
 */
function resolveModelPath(
  env: Record<string, string | undefined>,
  deps: Pick<LocalLlmRuntimeDeps, 'isFile' | 'modelPath'>,
): string {
  const override = env[LOCAL_MODEL_PATH_ENV]?.trim() || ''
  if (override) {
    if (basename(override).toLowerCase() !== LOCAL_MODEL_FILE.toLowerCase()) {
      throw new LocalLlmError(
        `Only ${LOCAL_MODEL_FILE} is supported by the local provider; ${LOCAL_MODEL_PATH_ENV} points at ${basename(override)}.`,
      )
    }
    if (!deps.isFile(override)) {
      throw new LocalLlmError(`The local model file was not found at ${override}.`)
    }
    return override
  }
  const managed = deps.modelPath()?.trim() || ''
  // a verified file that has since been moved or deleted counts as not installed
  if (!managed || !deps.isFile(managed)) throw new LocalLlmError(LOCAL_MODEL_NOT_INSTALLED_MESSAGE)
  return managed
}

/** Binary, model and sizing for one start; throws LocalLlmError with an actionable message. */
export function resolveLocalLaunch(
  config: AiProviderConfig,
  deps: Pick<LocalLlmRuntimeDeps, 'env' | 'isFile' | 'modelPath'>,
): LocalLlmLaunch {
  const env = deps.env()
  const binary = config.cliPath?.trim() || env[LLAMA_SERVER_PATH_ENV]?.trim() || ''
  if (!binary) {
    throw new LocalLlmError(
      `The local model needs the llama-server executable: set the provider's CLI path or ${LLAMA_SERVER_PATH_ENV}.`,
    )
  }
  if (hasPathSeparator(binary) && !deps.isFile(binary)) {
    throw new LocalLlmError(`llama-server was not found at ${binary}.`)
  }
  const model = resolveModelPath(env, deps)
  const ctxRaw = positiveInt(env[LOCAL_CTX_ENV])
  const ctx =
    ctxRaw === undefined ? LOCAL_DEFAULT_CTX : Math.min(MAX_CTX, Math.max(MIN_CTX, ctxRaw))
  const threads = positiveInt(env[LOCAL_THREADS_ENV])
  return { binary, model, ctx, ...(threads !== undefined ? { threads } : {}) }
}

/**
 * The llama-server command line. Text-only: no --mmproj. Sampling follows the LFM3-VL model card;
 * --jinja renders the model's own chat template, --reasoning-format deepseek streams the
 * <think> block as reasoning_content, and earlier reasoning is not kept in the prompt.
 */
export function llamaServerArgs(launch: LocalLlmLaunch, port: number, token: string): string[] {
  return [
    '-m',
    launch.model,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--api-key',
    token,
    '-c',
    String(launch.ctx),
    '-np',
    '1',
    ...(launch.threads !== undefined ? ['-t', String(launch.threads)] : []),
    '--jinja',
    '--reasoning-format',
    'deepseek',
    '--no-reasoning-preserve',
    '--temp',
    '0.1',
    '--top-p',
    '1.0',
    '--top-k',
    '50',
    '--min-p',
    '0.0',
    '--repeat-penalty',
    '1.1',
  ]
}

function abortError(): Error {
  const error = new Error('The request was cancelled')
  error.name = 'AbortError'
  return error
}

/** Waits for `promise` unless the caller gives up first; the shared start keeps running. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

interface Running {
  key: string
  child: ChildProcess
  endpoint: LocalLlmEndpoint
  ready: Promise<void>
  exited: boolean
  exitCode: number | null
  spawnError: string | null
  stderr: string
}

export function createLocalLlmRuntime(deps: LocalLlmRuntimeDeps): LocalLlmRuntime {
  let current: Running | null = null
  /** a start whose port lookup / spawn is still in flight, shared by concurrent callers */
  let pending: { key: string; promise: Promise<Running> } | null = null

  const stop = (running: Running) => {
    if (current === running) current = null
    if (!running.exited) {
      try {
        running.child.kill()
      } catch {
        // already gone
      }
    }
  }

  const failure = (running: Running, what: string): LocalLlmError => {
    const tail = running.stderr.trim()
    return new LocalLlmError(tail ? `${what}\n${tail}` : what)
  }

  const waitForHealth = async (running: Running): Promise<void> => {
    const deadline = deps.now() + deps.startupTimeoutMs
    const url = `${running.endpoint.baseUrl.replace(/\/v1$/, '')}/health`
    const headers = { Authorization: `Bearer ${running.endpoint.token}` }
    for (;;) {
      if (running.spawnError) throw failure(running, `Could not start llama-server: ${running.spawnError}`)
      if (running.exited) {
        throw failure(running, `llama-server exited before it was ready (exit code ${running.exitCode ?? 'unknown'}).`)
      }
      if (current !== running) throw new LocalLlmError('llama-server was stopped while it was starting.')
      try {
        if ((await deps.getStatus(url, headers)) === 200) return
      } catch {
        // not listening yet
      }
      if (deps.now() >= deadline) {
        stop(running)
        throw failure(
          running,
          `llama-server did not become ready within ${Math.round(deps.startupTimeoutMs / 1000)} s.`,
        )
      }
      await deps.sleep(HEALTH_POLL_MS)
    }
  }

  const start = async (launch: LocalLlmLaunch, key: string): Promise<Running> => {
    const port = await deps.freePort()
    const token = deps.token()
    const child = deps.spawn(launch.binary, llamaServerArgs(launch, port, token))
    const running: Running = {
      key,
      child,
      endpoint: { baseUrl: `http://127.0.0.1:${port}/v1`, token },
      ready: Promise.resolve(),
      exited: false,
      exitCode: null,
      spawnError: null,
      stderr: '',
    }
    child.stderr?.on('data', (chunk: Buffer | string) => {
      running.stderr = (running.stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error: Error) => {
      running.spawnError = error.message
      running.exited = true
      if (current === running) current = null
    })
    child.on('exit', (code: number | null) => {
      running.exited = true
      running.exitCode = code
      // a crash after start-up: the next ensure() starts a fresh process
      if (current === running) current = null
    })
    current = running
    running.ready = waitForHealth(running)
    // a failed start must not leave a half-started process registered
    running.ready.catch(() => {
      if (current === running) stop(running)
    })
    return running
  }

  return {
    async ensure(config, signal) {
      if (signal?.aborted) throw abortError()
      const launch = resolveLocalLaunch(config, deps)
      const key = JSON.stringify(launch)
      let running = current
      if (running && (running.key !== key || running.exited)) {
        stop(running)
        running = null
      }
      if (!running) {
        if (!pending || pending.key !== key) {
          const promise = start(launch, key)
          const entry = { key, promise }
          pending = entry
          void promise
            .catch(() => undefined)
            .finally(() => {
              if (pending === entry) pending = null
            })
        }
        running = await untilAborted(pending.promise, signal)
      }
      await untilAborted(running.ready, signal)
      return running.endpoint
    },
    shutdown() {
      pending = null
      if (current) stop(current)
    },
  }
}

const realDeps: LocalLlmRuntimeDeps = {
  spawn: (command, args) =>
    nodeSpawn(command, args, {
      cwd: tmpdir(),
      shell: false,
      windowsHide: true,
      // stdout is not read; leaving it piped would eventually block the server on a full pipe
      stdio: ['ignore', 'ignore', 'pipe'],
    }),
  getStatus: async (url, headers) => {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    })
    // the body is irrelevant; drain it so the connection can be reused
    await response.body?.cancel().catch(() => undefined)
    return response.status
  },
  freePort: () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server.close(() => (port ? resolve(port) : reject(new Error('No free port available'))))
      })
    }),
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  env: () => process.env,
  modelPath: () => {
    try {
      return localModelResolver?.() ?? null
    } catch {
      return null // a failing resolver means no model, never a crash of the request
    }
  },
  token: () => randomBytes(24).toString('hex'),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  startupTimeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
}

const runtime = createLocalLlmRuntime(realDeps)

/** The ready endpoint of the managed llama-server, starting it when needed. */
export function ensureLocalLlm(
  config: AiProviderConfig,
  signal?: AbortSignal,
): Promise<LocalLlmEndpoint> {
  return runtime.ensure(config, signal)
}

/** Stops the managed llama-server (app quit). Safe to call when nothing is running. */
export function shutdownLocalLlm(): void {
  runtime.shutdown()
}
