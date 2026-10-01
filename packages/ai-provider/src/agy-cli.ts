import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  constants as fsConstants,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentImage, AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import type { StreamCallbacks } from './protocols/shared'
import type { AiChatResponse, AiProviderConfig, AiTokenUsage, CodexModelCatalog } from './types'
import { AiTimeoutError } from './watchdog'

/**
 * "Antigravity CLI" provider (`agy`). Unlike the HTTP providers this drives the
 * user's local Antigravity agent in non-interactive print mode, one process per
 * request, so the account, quota and model access are the user's own.
 *
 * Limits (by design, not bugs):
 *  - text + image only: GenOffice's function-calling tools cannot be mapped onto
 *    agy's internal tools, so they go through a text protocol instead: the tools are
 *    described in the prompt, agy answers with <tool_call> blocks and the host runs
 *    them (see agy-tools.ts);
 *  - stateless: every call flattens the chat history into one prompt;
 *  - slower than an API call: each request starts the agent (several seconds)
 *    and carries ~15-30k tokens of agent overhead on the account's quota.
 */

import { AGY_DEFAULT_MODEL } from './agy-meta'
import {
  agyToolNote,
  parseAgyToolCalls,
  renderAgyToolCalls,
  renderAgyToolResult,
} from './agy-tools'

export {
  AGY_CAPABILITIES,
  AGY_DEFAULT_MODEL,
  AGY_PROVIDER_ID,
  AGY_PROVIDER_META,
  isCliProvider,
} from './agy-meta'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const AGY_MAX_CONCURRENCY = 2
export const AGY_REQUEST_TIMEOUT_MS = 240_000
export const AGY_MODELS_TIMEOUT_MS = 30_000
export const AGY_MODELS_CACHE_MS = 3 * 60_000
/** one staged file */
export const AGY_MAX_FILE_BYTES = 20 * 1024 * 1024
/** all files of one request */
export const AGY_MAX_TOTAL_BYTES = 40 * 1024 * 1024
export const AGY_MAX_FILES = 12
/** flattened prompt cap; the oldest turns are dropped first */
export const AGY_MAX_PROMPT_CHARS = 400_000
const MAX_STDERR_CHARS = 8_000
const MAX_LINE_CHARS = 8 * 1024 * 1024
const PING_INTERVAL_MS = 5_000

// ---------------------------------------------------------------------------
// Path + argument validation (nothing user-controlled ever reaches a shell)
// ---------------------------------------------------------------------------

const SHELL_META = /[\0\r\n&|<>^%"'`;$(){}*?!]/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

export function isSafeAgyModelId(model: string): boolean {
  return MODEL_ID.test(model)
}

export interface AgyFsDeps {
  isFile(path: string): Promise<boolean>
  /** POSIX execute bit (never consulted on win32) */
  isExecutable(path: string): Promise<boolean>
  /**
   * `$SHELL -lc 'command -v agy'` with a short timeout (macOS GUI apps do not
   * inherit the shell PATH). Resolves with the printed path, or undefined.
   */
  loginShellLookup(shell: string): Promise<string | undefined>
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}

/** The one fixed command line of the login-shell lookup; no user text is ever interpolated. */
export const AGY_LOGIN_SHELL_COMMAND = 'command -v agy'

const realFsDeps: AgyFsDeps = {
  isFile: async (path) => {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  },
  isExecutable: async (path) => {
    try {
      await access(path, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  },
  loginShellLookup: (shell) =>
    new Promise<string | undefined>((resolve) => {
      try {
        const child = spawn(shell, ['-lc', AGY_LOGIN_SHELL_COMMAND], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
        })
        let out = ''
        child.stdout.on('data', (c: Buffer) => {
          if (out.length < 4096) out += c.toString('utf8')
        })
        child.on('error', () => resolve(undefined))
        child.on('close', () => resolve(out.trim().split(/\r?\n/).pop() || undefined))
      } catch {
        resolve(undefined)
      }
    }),
  platform: process.platform,
  env: process.env,
  home: homedir(),
}

/** Throws a user-readable error unless `path` is an absolute, metacharacter-free path of an existing executable file. */
export async function validateAgyCliPath(
  path: string,
  deps: AgyFsDeps = realFsDeps,
): Promise<void> {
  const win = deps.platform === 'win32'
  const absolute = win ? win32.isAbsolute(path) : posix.isAbsolute(path)
  if (!path || SHELL_META.test(path) || !absolute) {
    throw new Error('The Antigravity CLI path must be an absolute path to the agy executable')
  }
  // shell:false cannot run .cmd/.bat (and must not), so Windows needs the real .exe
  if (win && !/\.exe$/i.test(path)) {
    throw new Error('The Antigravity CLI path must point to agy.exe')
  }
  if (!(await deps.isFile(path))) throw new Error(`Antigravity CLI not found at ${path}`)
  if (!win && !(await deps.isExecutable(path))) {
    throw new Error(`Antigravity CLI at ${path} is not executable (chmod +x)`)
  }
}

/** Platform-appropriate default install locations, in lookup order (after PATH). */
export function agyDefaultLocations(deps: Pick<AgyFsDeps, 'platform' | 'env' | 'home'>): string[] {
  if (deps.platform === 'win32') {
    const base = deps.env.LOCALAPPDATA
    return base ? [win32.join(base, 'agy', 'bin', 'agy.exe')] : []
  }
  const list = ['/usr/local/bin/agy', '/opt/homebrew/bin/agy']
  if (deps.home) {
    list.unshift(
      posix.join(deps.home, '.local', 'bin', 'agy'),
      posix.join(deps.home, '.agy', 'bin', 'agy'),
    )
  }
  return list
}

/** Short, OS-appropriate description of where auto-detection looks (for the settings hint). */
export function agyAutoDetectHint(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'PATH, then %LOCALAPPDATA%\\agy\\bin\\agy.exe'
    : 'PATH, ~/.local/bin, ~/.agy/bin, /usr/local/bin, /opt/homebrew/bin, then your login shell'
}

/**
 * The configured path, else `agy` on PATH, else the per-user install location,
 * else (POSIX) the user's login shell. The result is always validated; failure
 * explains how to fix it.
 */
export async function resolveAgyCliPath(
  configured: string | undefined,
  deps: AgyFsDeps = realFsDeps,
): Promise<string> {
  const explicit = configured?.trim()
  if (explicit) {
    await validateAgyCliPath(explicit, deps)
    return explicit
  }
  const win = deps.platform === 'win32'
  const pathJoin = win ? win32.join : posix.join
  const candidates: string[] = []
  const pathVar = deps.env.PATH ?? deps.env.Path ?? ''
  for (const dir of pathVar.split(win ? ';' : ':')) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    if (trimmed) candidates.push(pathJoin(trimmed, win ? 'agy.exe' : 'agy'))
  }
  candidates.push(...agyDefaultLocations(deps))
  const tryCandidate = async (candidate: string): Promise<boolean> => {
    try {
      await validateAgyCliPath(candidate, deps)
      return true
    } catch {
      return false
    }
  }
  for (const candidate of candidates) if (await tryCandidate(candidate)) return candidate
  // Finder-launched Electron has a minimal PATH: ask the user's login shell, once, with a fixed command.
  const shell = deps.env.SHELL?.trim()
  if (!win && shell && posix.isAbsolute(shell) && !SHELL_META.test(shell)) {
    const found = (await deps.loginShellLookup(shell))?.trim()
    if (found && (await tryCandidate(found))) return found
  }
  throw new Error(
    'Antigravity CLI (agy) was not found. Install it, or set its full path in Settings → AI Model.',
  )
}

export interface AgyArgsInput {
  model: string
  stagingDir: string
  timeoutMs: number
}

/**
 * Argument vector for one print-mode turn. The prompt travels on stdin as one
 * stream-json message (`-p ""` selects print mode), so neither the Windows
 * command-line limit nor shell quoting applies. `--sandbox` keeps the agent's
 * terminal restricted; permissions are never auto-approved.
 */
export function buildAgyArgs(input: AgyArgsInput): string[] {
  if (!isSafeAgyModelId(input.model)) throw new Error('Invalid Antigravity model id')
  const printTimeoutS = Math.max(10, Math.floor(input.timeoutMs / 1000) - 5)
  return [
    '-p',
    '',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    input.model,
    '--sandbox',
    '--disable-slash-commands',
    '--print-timeout',
    `${printTimeoutS}s`,
    '--add-dir',
    input.stagingDir,
  ]
}

/** The single stdin line that starts a turn. */
export function buildAgyStdin(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** `agy models` prints tab-separated `id<TAB>Display Name`; progress noise may share the stream. */
export function parseAgyModels(output: string): string[] {
  const ids: string[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const id = line.split('\t')[0]!.trim()
    // noise such as "Fetching available models..." has spaces and no tab
    if (!line.includes('\t') || !isSafeAgyModelId(id)) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export interface AgyUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

/** an action the sandboxed headless agent was not allowed to take (`result.denied_actions`) */
export interface AgyDeniedAction {
  action: string
  displayName: string
}

export type AgyEvent =
  | { kind: 'init'; model?: string; conversationId?: string }
  | { kind: 'text'; text: string; stepIndex: number; done: boolean }
  | { kind: 'step'; stepType: string }
  | {
      kind: 'result'
      ok: boolean
      response: string
      error?: string
      usage?: AgyUsage
      conversationId?: string
      deniedActions?: AgyDeniedAction[]
    }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseDeniedActions(value: unknown): AgyDeniedAction[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.flatMap((item) => {
    const entry = record(item)
    if (!entry) return []
    return [
      {
        action: typeof entry.action === 'string' ? entry.action : '',
        displayName: typeof entry.display_name === 'string' ? entry.display_name : '',
      },
    ]
  })
}

/** One NDJSON line of `--output-format stream-json`; unknown or malformed lines yield null. */
export function parseAgyStreamLine(line: string): AgyEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const obj = record(parsed)
  if (!obj) return null
  if (obj.event === 'init') {
    const init = record(obj.init)
    return {
      kind: 'init',
      ...(typeof init?.model === 'string' ? { model: init.model } : {}),
      ...(typeof obj.conversation_id === 'string' ? { conversationId: obj.conversation_id } : {}),
    }
  }
  if (obj.event === 'step_update') {
    const step = record(obj.step_update)
    if (!step) return null
    const stepType = typeof step.step_type === 'string' ? step.step_type : ''
    if (stepType === 'agent_response' && typeof step.text_delta === 'string') {
      return {
        kind: 'text',
        text: step.text_delta,
        stepIndex: typeof step.step_index === 'number' ? step.step_index : 0,
        done: step.state === 'DONE',
      }
    }
    return { kind: 'step', stepType }
  }
  if (obj.event === 'result') {
    const result = record(obj.result)
    if (!result) return null
    const ok = result.status === 'SUCCESS'
    return {
      kind: 'result',
      ok,
      response: typeof result.response === 'string' ? result.response : '',
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
      ...(record(result.usage) ? { usage: result.usage as AgyUsage } : {}),
      ...(typeof result.conversation_id === 'string'
        ? { conversationId: result.conversation_id }
        : {}),
      ...(parseDeniedActions(result.denied_actions)
        ? { deniedActions: parseDeniedActions(result.denied_actions)! }
        : {}),
    }
  }
  return null
}

export function agyUsageToTokenUsage(usage: AgyUsage): AiTokenUsage {
  const out: AiTokenUsage = {}
  if (typeof usage.input_tokens === 'number') out.promptTokenCount = usage.input_tokens
  if (typeof usage.output_tokens === 'number') out.candidatesTokenCount = usage.output_tokens
  if (typeof usage.thinking_tokens === 'number') out.thoughtsTokenCount = usage.thinking_tokens
  if (typeof usage.cache_read_tokens === 'number') {
    out.cachedContentTokenCount = usage.cache_read_tokens
  }
  if (typeof usage.total_tokens === 'number') out.totalTokenCount = usage.total_tokens
  return out
}

/** First useful lines of an agy error, without the trailing model list it echoes. */
export function cleanAgyError(message: string): string {
  const head = message.split(/\r?\n(?:Available models:|Usage of )/)[0] ?? message
  const text = head.replace(/\s+/g, ' ').trim()
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

// ---------------------------------------------------------------------------
// Prompt flattening + staging
// ---------------------------------------------------------------------------

export const AGY_SYSTEM_NOTE =
  'You are answering inside a desktop office suite through a plain text channel. ' +
  "The host application's document-editing tools are NOT available in this session: " +
  'you cannot open, edit, create or save the user’s documents, and you must not try. ' +
  'Reply with text only. Do not run shell commands, browse the web or modify any file. ' +
  'The only files you may read are the attachments listed below, which sit in the current directory. ' +
  'If the user asks for an edit you cannot perform, say so briefly and provide the revised text they can paste.'

/** Same text channel, but the host runs the document tools that agy requests in <tool_call> blocks. */
export const AGY_TOOLS_SYSTEM_NOTE =
  'You are answering inside a desktop office suite through a plain text channel. ' +
  'You cannot open, edit or save documents yourself, and you must not run shell commands, browse the web or modify any file. ' +
  'The only files you may read are the attachments listed below, which sit in the current directory. ' +
  'Everything you can do to the user’s documents goes through the host tools described below.'

function imageExtension(image: AgentImage): string {
  const subtype = image.mime.split('/')[1]?.toLowerCase() ?? ''
  if (subtype === 'jpeg' || subtype === 'jpg') return '.jpg'
  if (subtype === 'png') return '.png'
  if (subtype === 'webp') return '.webp'
  if (subtype === 'gif') return '.gif'
  return '.png'
}

export interface AgyStagedFile {
  /** file name inside the staging directory (no separators) */
  name: string
  bytes: Uint8Array
}

export interface AgyPromptPlan {
  prompt: string
  files: AgyStagedFile[]
}

/** base64 payload size without decoding it */
function base64Bytes(base64: string): number {
  const clean = base64.length
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((clean * 3) / 4) - pad
}

/**
 * Flatten system prompt + chat history into one prompt and collect the image
 * attachments to stage. Oldest turns are dropped to respect AGY_MAX_PROMPT_CHARS;
 * only the newest AGY_MAX_FILES images within the size caps are staged (an image
 * that cannot be staged is mentioned in the prompt so the model does not guess).
 */
export function buildAgyPrompt(
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[] = [],
): AgyPromptPlan {
  // newest-first image budget
  const staged = new Map<AgentImage, string>()
  const skipped = new Set<AgentImage>()
  let total = 0
  let count = 0
  const allImages: AgentImage[] = []
  for (const m of messages) if (m.role === 'user') allImages.push(...(m.images ?? []))
  for (const image of [...allImages].reverse()) {
    const size = base64Bytes(image.base64)
    if (count >= AGY_MAX_FILES || size > AGY_MAX_FILE_BYTES || total + size > AGY_MAX_TOTAL_BYTES) {
      skipped.add(image)
      continue
    }
    total += size
    count++
    staged.set(image, '')
  }
  // names in chronological order
  const files: AgyStagedFile[] = []
  let n = 0
  for (const image of allImages) {
    if (!staged.has(image)) continue
    n++
    const name = `image-${n}${imageExtension(image)}`
    staged.set(image, name)
    files.push({ name, bytes: Buffer.from(image.base64, 'base64') })
  }

  const turns: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const refs = (m.images ?? []).map((image) =>
        staged.has(image)
          ? `[attached image: ${staged.get(image)}]`
          : '[an attached image was too large or too many images; it is not available]',
      )
      turns.push(`User: ${[m.text, ...refs].filter(Boolean).join('\n')}`)
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls?.length ? renderAgyToolCalls(m.toolCalls) : ''
      const said = [m.text.trim(), calls].filter(Boolean).join('\n')
      if (said) turns.push(`Assistant: ${said}`)
    } else {
      for (const r of m.results) {
        if (tools.length) {
          turns.push(renderAgyToolResult(r))
          continue
        }
        const out = r.output.length > 2000 ? `${r.output.slice(0, 2000)}…` : r.output
        turns.push(`Tool result (${r.name}): ${out}`)
      }
    }
  }
  const header =
    `${tools.length ? AGY_TOOLS_SYSTEM_NOTE : AGY_SYSTEM_NOTE}\n\n` +
    (tools.length ? `${agyToolNote(tools)}\n\n` : '') +
    (system.trim() ? `Instructions from the application:\n${system.trim()}\n\n` : '') +
    (files.length
      ? `Attachments in the current directory: ${files.map((f) => f.name).join(', ')}\n\n`
      : '')
  const footer = '\n\nWrite the Assistant’s next reply to the last User message.'
  const budget = AGY_MAX_PROMPT_CHARS - header.length - footer.length
  // keep the newest turns that fit; the last turn is always kept (truncated if huge)
  const kept: string[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    if (used + turn.length > budget) {
      if (kept.length === 0) kept.unshift(turn.slice(turn.length - Math.max(0, budget)))
      break
    }
    kept.unshift(turn)
    used += turn.length + 2
  }
  const dropped = turns.length - kept.length
  const body =
    (dropped > 0 ? `(${dropped} earlier message(s) omitted for length)\n\n` : '') +
    `Conversation:\n${kept.join('\n\n')}`
  return { prompt: `${header}${body}${footer}`, files }
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

export interface AgyRunDeps extends AgyFsDeps {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): ChildProcessWithoutNullStreams
  killTree(child: ChildProcessWithoutNullStreams): void
  makeStagingDir(): Promise<string>
  removeDir(dir: string): Promise<void>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
}

/** SIGKILL escalation delay after the polite SIGTERM on POSIX */
export const AGY_KILL_GRACE_MS = 2000

/**
 * Kill the child and everything it started. Windows: `taskkill /T /F`. POSIX:
 * the child leads its own process group (spawned detached), so signal the group
 * with SIGTERM and escalate to SIGKILL after a grace period.
 */
export function killProcessTree(
  child: Pick<ChildProcessWithoutNullStreams, 'pid' | 'kill'>,
  platform: NodeJS.Platform = process.platform,
  signalGroup: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) =>
    process.kill(pid, signal),
  runTaskkill: (pid: number) => void = (pid) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    })
    killer.on('error', () => child.kill())
    killer.unref()
  },
): void {
  const pid = child.pid
  if (pid === undefined) return
  if (platform === 'win32') {
    try {
      runTaskkill(pid)
    } catch {
      child.kill()
    }
    return
  }
  const send = (signal: NodeJS.Signals) => {
    try {
      signalGroup(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }
  send('SIGTERM')
  setTimeout(() => send('SIGKILL'), AGY_KILL_GRACE_MS).unref()
}

const realRunDeps: AgyRunDeps = {
  ...realFsDeps,
  spawn: (command, args, options) =>
    spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }),
  killTree: killProcessTree,
  makeStagingDir: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-agy-'))
    if (process.platform !== 'win32') await chmod(dir, 0o700)
    return dir
  },
  removeDir: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  writeFile: (path, bytes) => writeFile(path, bytes),
}

function abortError(): Error {
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  return error
}

/** FIFO semaphore; queued waiters leave on abort. */
class Limiter {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly max: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError()
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(abortError())
        }
        this.waiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}

export function createAgyLimiter(max = AGY_MAX_CONCURRENCY): Limiter {
  return new Limiter(max)
}
const requestLimiter = createAgyLimiter()

export interface AgyRunOptions {
  cliPath?: string | undefined
  model: string
  prompt: string
  files?: AgyStagedFile[]
  signal?: AbortSignal | undefined
  timeoutMs?: number
  /** streamed assistant text */
  onText?: (text: string) => void
  onUsage?: (usage: AiTokenUsage) => void
  /** fires on every stdout chunk and on a 5 s heartbeat while the process lives */
  onActivity?: () => void
  limiter?: Limiter
}

export interface AgyRunResult {
  text: string
  usage?: AiTokenUsage
  /** agy's own conversation id (names its `brain/<id>` working folder) */
  conversationId?: string
  /** sandbox refusals reported with the result, if any */
  deniedActions?: AgyDeniedAction[]
}

/**
 * Run one print-mode turn. Resolves with the full text; rejects with an
 * AbortError on cancel, AiTimeoutError on timeout, or a plain Error carrying
 * agy's own message. Stderr is progress noise and is only consulted when the
 * process fails without a JSON result. Prompts and file contents are never logged.
 */
export async function runAgy(
  options: AgyRunOptions,
  deps: AgyRunDeps = realRunDeps,
): Promise<AgyRunResult> {
  const timeoutMs = options.timeoutMs ?? AGY_REQUEST_TIMEOUT_MS
  const files = options.files ?? []
  if (files.length > AGY_MAX_FILES) throw new Error('Too many attachments for Antigravity')
  let totalBytes = 0
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file.name)) throw new Error('Invalid file name')
    if (file.bytes.byteLength > AGY_MAX_FILE_BYTES) throw new Error('Attachment is too large')
    totalBytes += file.bytes.byteLength
  }
  if (totalBytes > AGY_MAX_TOTAL_BYTES) throw new Error('Attachments are too large')
  const cliPath = await resolveAgyCliPath(options.cliPath, deps)
  const limiter = options.limiter ?? requestLimiter
  const release = await limiter.acquire(options.signal)
  let stagingDir: string | undefined
  try {
    if (options.signal?.aborted) throw abortError()
    stagingDir = await deps.makeStagingDir()
    for (const file of files) await deps.writeFile(join(stagingDir, file.name), file.bytes)
    const args = buildAgyArgs({ model: options.model, stagingDir, timeoutMs })
    return await new Promise<AgyRunResult>((resolve, reject) => {
      const child = deps.spawn(cliPath, args, { cwd: stagingDir!, env: { ...deps.env } })
      let settled = false
      let text = ''
      let lastStep = -1
      let usage: AiTokenUsage | undefined
      let conversationId: string | undefined
      let resultSeen: Extract<AgyEvent, { kind: 'result' }> | undefined
      let stderr = ''
      const decoder = new StringDecoder('utf8')
      let pending = ''
      const cleanup = () => {
        clearTimeout(timer)
        clearInterval(heartbeat)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        action()
      }
      const fail = (error: Error) =>
        finish(() => {
          deps.killTree(child)
          reject(error)
        })
      const onAbort = () => fail(abortError())
      const timer = setTimeout(() => fail(new AiTimeoutError(timeoutMs)), timeoutMs)
      const heartbeat = setInterval(() => options.onActivity?.(), PING_INTERVAL_MS)
      if (options.signal?.aborted) return fail(abortError())
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const handleLine = (line: string) => {
        const event = parseAgyStreamLine(line)
        if (!event) return
        if (event.kind === 'init' && event.conversationId) conversationId = event.conversationId
        if (event.kind === 'text') {
          // a new agent_response step (after tool use) starts a new paragraph
          const prefix = text && lastStep !== -1 && event.stepIndex !== lastStep ? '\n\n' : ''
          lastStep = event.stepIndex
          const chunk = prefix + event.text
          if (chunk) {
            text += chunk
            options.onText?.(chunk)
          }
        } else if (event.kind === 'result') {
          resultSeen = event
          conversationId = event.conversationId || conversationId
          if (event.usage) {
            usage = agyUsageToTokenUsage(event.usage)
            options.onUsage?.(usage)
          }
        }
      }
      const feed = (chunk: Buffer) => {
        options.onActivity?.()
        pending += decoder.write(chunk)
        let nl = pending.indexOf('\n')
        while (nl >= 0) {
          handleLine(pending.slice(0, nl))
          pending = pending.slice(nl + 1)
          nl = pending.indexOf('\n')
        }
        if (pending.length > MAX_LINE_CHARS) pending = ''
      }
      child.stdout.on('data', feed)
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_CHARS)
          stderr += chunk.toString('utf8').slice(0, MAX_STDERR_CHARS)
      })
      child.stdin.on('error', () => undefined)
      child.on('error', (error) =>
        fail(new Error(`Could not start Antigravity CLI: ${error.message}`)),
      )
      child.on('close', (code) =>
        finish(() => {
          pending += decoder.end()
          if (pending.trim()) handleLine(pending)
          if (resultSeen?.ok) {
            // some turns carry the text only in the final result
            const full = text || resultSeen.response
            if (!text && resultSeen.response) options.onText?.(resultSeen.response)
            resolve({
              text: full,
              ...(usage ? { usage } : {}),
              ...(conversationId ? { conversationId } : {}),
              ...(resultSeen.deniedActions ? { deniedActions: resultSeen.deniedActions } : {}),
            })
            return
          }
          const detail = resultSeen?.error ?? stderr.trim().split(/\r?\n/).pop() ?? ''
          reject(
            new Error(
              cleanAgyError(detail) ||
                `Antigravity CLI exited with code ${code ?? 'unknown'} without a result`,
            ),
          )
        }),
      )
      child.stdin.end(buildAgyStdin(options.prompt))
    })
  } finally {
    release()
    if (stagingDir) await deps.removeDir(stagingDir).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Provider entry points (same shapes as the other transports)
// ---------------------------------------------------------------------------

/**
 * Streaming turn. With tools, agy asks for them through <tool_call> blocks (see agy-tools.ts);
 * the reply is then shown once complete so a block never leaks into the visible text.
 */
export async function streamAgy(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  _maxTokens: number,
  cb: StreamCallbacks,
  deps?: AgyRunDeps,
): Promise<void> {
  const plan = buildAgyPrompt(system, messages, tools)
  const result = await runAgy(
    {
      cliPath: config.cliPath,
      model: config.model?.trim() || AGY_DEFAULT_MODEL,
      prompt: plan.prompt,
      files: plan.files,
      signal: cb.signal,
      ...(tools.length ? {} : { onText: cb.onDelta }),
      ...(cb.onUsage ? { onUsage: cb.onUsage } : {}),
      ...(cb.onActivity ? { onActivity: cb.onActivity } : {}),
    },
    deps,
  )
  if (!result.text.trim()) throw new Error('Antigravity CLI returned no content')
  if (tools.length) {
    const parsed = parseAgyToolCalls(result.text, new Set(tools.map((t) => t.name)))
    if (parsed.text) cb.onDelta(parsed.text)
    for (const call of parsed.calls) cb.onToolCall(call)
    cb.onStopReason?.(parsed.calls.length ? 'tool_use' : 'end_turn')
    return
  }
  cb.onStopReason?.('end_turn')
}

/** One-shot text chat (settings test, summaries). */
export async function chatAgy(
  config: AiProviderConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
  deps?: AgyRunDeps,
): Promise<AiChatResponse> {
  try {
    const plan = buildAgyPrompt(system, [{ role: 'user', text: user }])
    const result = await runAgy(
      {
        cliPath: config.cliPath,
        model: config.model?.trim() || AGY_DEFAULT_MODEL,
        prompt: plan.prompt,
        signal,
      },
      deps,
    )
    return result.text.trim()
      ? { ok: true, content: result.text }
      : { ok: false, error: 'Antigravity CLI returned no content' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Image understanding through agy (media analysis provider): images are staged next to the prompt. */
export async function analyzeImagesWithAgy(
  input: {
    cliPath?: string | undefined
    model?: string | undefined
    prompt: string
    images: AgentImage[]
    signal?: AbortSignal | undefined
  },
  deps?: AgyRunDeps,
): Promise<string> {
  const plan = buildAgyPrompt('', [{ role: 'user', text: input.prompt, images: input.images }])
  const result = await runAgy(
    {
      cliPath: input.cliPath,
      model: input.model?.trim() || AGY_DEFAULT_MODEL,
      prompt: plan.prompt,
      files: plan.files,
      signal: input.signal,
    },
    deps,
  )
  return result.text
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export interface AgyModelCatalog extends CodexModelCatalog {
  /** present when `agy models` could not run; the picker keeps its previous list */
  error?: string
}

export interface AgyModelsDeps extends AgyFsDeps {
  /** run `agy models`, resolving with stdout (stderr noise ignored) */
  run(cliPath: string, signal: AbortSignal): Promise<string>
  now(): number
}

const realModelsDeps: AgyModelsDeps = {
  ...realFsDeps,
  now: () => Date.now(),
  run: (cliPath, signal) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(cliPath, ['models'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (c: Buffer) => {
        if (out.length < 200_000) out += c.toString('utf8')
      })
      child.stderr.on('data', (c: Buffer) => {
        if (err.length < MAX_STDERR_CHARS) err += c.toString('utf8')
      })
      const onAbort = () => {
        child.kill()
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (e) => reject(e))
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (code === 0) resolve(out)
        else reject(new Error(cleanAgyError(err || out) || `agy models exited with code ${code}`))
      })
    }),
}

const modelsCache = new Map<string, { at: number; models: string[] }>()

export function clearAgyModelsCache(): void {
  modelsCache.clear()
}

/** `agy models`, cached for a few minutes. Never throws: failures come back as `error`. */
export async function listAgyModels(
  cliPath?: string,
  deps: AgyModelsDeps = realModelsDeps,
  options: { force?: boolean } = {},
): Promise<AgyModelCatalog> {
  try {
    const resolved = await resolveAgyCliPath(cliPath, deps)
    const cached = modelsCache.get(resolved)
    if (!options.force && cached && deps.now() - cached.at < AGY_MODELS_CACHE_MS) {
      return catalogOf(cached.models)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AGY_MODELS_TIMEOUT_MS)
    let output: string
    try {
      output = await deps.run(resolved, controller.signal)
    } finally {
      clearTimeout(timer)
    }
    const models = parseAgyModels(output)
    if (models.length === 0)
      throw new Error('Antigravity CLI returned no models. Are you signed in?')
    modelsCache.set(resolved, { at: deps.now(), models })
    return catalogOf(models)
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      models: [],
      defaultModel: '',
      error: aborted
        ? 'Timed out waiting for `agy models`'
        : error instanceof Error
          ? error.message
          : String(error),
    }
  }
}

function catalogOf(models: string[]): AgyModelCatalog {
  return {
    models,
    defaultModel: models.includes(AGY_DEFAULT_MODEL) ? AGY_DEFAULT_MODEL : (models[0] ?? ''),
  }
}

/** IPC-facing wrapper: `input` is the renderer's `{ cliPath? }`-shaped config, which is untrusted. */
export function listAgyModelsForIpc(input: unknown): Promise<AgyModelCatalog> {
  const raw = input !== null && typeof input === 'object' ? (input as { cliPath?: unknown }) : {}
  return listAgyModels(
    typeof raw.cliPath === 'string' ? raw.cliPath.trim() : undefined,
    undefined,
    {
      force: true,
    },
  )
}

/** unique id helper kept exported for tests that need deterministic staging names */
export const agyRequestId = (): string => randomUUID()
