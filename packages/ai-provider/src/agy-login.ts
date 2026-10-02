import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { killProcessTree, resolveAgyCliPath } from './agy-cli'
import type { AgyLoginPhase, AgyLoginState } from './agy-chat'

/**
 * Sign the Antigravity CLI in without a terminal. `agy` asks for a login by printing a Google
 * URL and then reads the authorization code from stdin, so the app opens that URL in the
 * browser, takes the code the person pastes and writes it to the CLI.
 */
export type { AgyLoginPhase, AgyLoginState }

export interface AgyLoginDeps {
  resolveCli(): Promise<string>
  spawn(cli: string, args: readonly string[]): ChildProcess
  openUrl(url: string): void
  onChange(state: AgyLoginState): void
  /** give up after this long (ms) */
  timeoutMs?: number
}

const LOGIN_ARGS = ['-p', '/usage', '--output-format', 'json', '--print-timeout', '240s'] as const
const URL_PATTERN = /https:\/\/accounts\.google\.com\/[^\s"']+/

const realDeps = (
  onChange: AgyLoginDeps['onChange'],
  openUrl: AgyLoginDeps['openUrl'],
): AgyLoginDeps => ({
  resolveCli: () => resolveAgyCliPath(undefined),
  spawn: (cli, args) =>
    spawn(cli, [...args], {
      cwd: tmpdir(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }),
  openUrl,
  onChange,
})

export class AgyLogin {
  private current: AgyLoginState = { phase: 'idle' }
  private child: ChildProcess | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly deps: AgyLoginDeps

  constructor(deps: AgyLoginDeps)
  constructor(onChange: AgyLoginDeps['onChange'], openUrl: AgyLoginDeps['openUrl'])
  constructor(first: AgyLoginDeps | AgyLoginDeps['onChange'], openUrl?: AgyLoginDeps['openUrl']) {
    this.deps = typeof first === 'function' ? realDeps(first, openUrl ?? (() => undefined)) : first
  }

  state(): AgyLoginState {
    return { ...this.current }
  }

  private set(next: AgyLoginState): void {
    this.current = next
    this.deps.onChange({ ...next })
  }

  /** Start (or restart) a sign-in; the browser opens by itself once the CLI gives the URL. */
  async start(): Promise<AgyLoginState> {
    this.stop()
    this.set({ phase: 'starting' })
    let cli: string
    try {
      cli = await this.deps.resolveCli()
    } catch {
      this.set({ phase: 'failed', error: 'cli-missing' })
      return this.state()
    }
    let child: ChildProcess
    try {
      child = this.deps.spawn(cli, LOGIN_ARGS)
    } catch {
      this.set({ phase: 'failed', error: 'failed' })
      return this.state()
    }
    this.child = child
    let seen = ''
    let opened = false
    let output = ''
    const read = (chunk: Buffer | string) => {
      const text = chunk.toString()
      output += text
      if (output.length > 200_000) output = output.slice(-100_000)
      if (opened) return
      seen += text
      const match = URL_PATTERN.exec(seen)
      if (!match) return
      opened = true
      this.set({ phase: 'waiting', url: match[0] })
      this.deps.openUrl(match[0])
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', () => {
      if (this.child === child) this.finish(child, { phase: 'failed', error: 'failed' })
    })
    child.on('close', (code) => {
      if (this.child !== child) return
      const signedIn =
        code === 0 &&
        output.includes('{') &&
        !/Authentication required/i.test(output.slice(output.lastIndexOf('{')))
      if (signedIn) this.finish(child, { phase: 'done' })
      else {
        const wasWaiting = this.current.phase === 'checking'
        this.finish(child, {
          phase: 'failed',
          error: wasWaiting ? 'rejected' : opened ? 'timeout' : 'failed',
          ...(this.current.url ? { url: this.current.url } : {}),
        })
      }
    })
    this.timer = setTimeout(
      () => {
        if (this.child === child) {
          killProcessTree(child)
          this.finish(child, { phase: 'failed', error: 'timeout' })
        }
      },
      this.deps.timeoutMs ?? 5 * 60_000,
    )
    this.timer.unref?.()
    return this.state()
  }

  /** The code the sign-in page shows; written to the CLI as if typed. */
  submitCode(raw: string): boolean {
    const code = raw.trim()
    if (!code || !this.child || this.current.phase !== 'waiting') return false
    try {
      this.child.stdin?.write(`${code}\n`)
    } catch {
      return false
    }
    this.set({ phase: 'checking', ...(this.current.url ? { url: this.current.url } : {}) })
    return true
  }

  cancel(): void {
    this.stop()
    this.set({ phase: 'idle' })
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) killProcessTree(child)
  }

  private finish(child: ChildProcess, next: AgyLoginState): void {
    if (this.child !== child) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.child = null
    this.set(next)
  }
}
