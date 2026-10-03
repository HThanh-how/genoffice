import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { killProcessTree, resolveAgyCliPath } from './agy-cli'
import type { AgyInstallState } from './agy-chat'

/**
 * Installs the Antigravity CLI the way Google documents it (https://antigravity.google/docs/cli/install):
 * their own install script, run for this user only (no administrator rights; it puts `agy` in
 * %LOCALAPPDATA%\agy\bin on Windows and ~/.local/bin elsewhere). The command lines are fixed, nothing
 * the person types is ever part of them, and the app only runs one when the person has agreed.
 * Running it again installs the newest version.
 */
export type { AgyInstallState }

export const AGY_INSTALL_URL_WINDOWS = 'https://antigravity.google/cli/install.ps1'
export const AGY_INSTALL_URL_POSIX = 'https://antigravity.google/cli/install.sh'

/** The program and arguments that run the official installer on this platform (null: unsupported). */
export function agyInstallCommand(
  platform: NodeJS.Platform,
): { file: string; args: string[] } | null {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `irm ${AGY_INSTALL_URL_WINDOWS} | iex`,
      ],
    }
  }
  if (platform === 'darwin' || platform === 'linux') {
    return { file: '/bin/bash', args: ['-c', `curl -fsSL ${AGY_INSTALL_URL_POSIX} | bash`] }
  }
  return null
}

export interface AgyInstallDeps {
  platform: NodeJS.Platform
  spawn(file: string, args: readonly string[]): ChildProcess
  /** the path of `agy` once it is installed; rejects when there is none */
  resolveCli(): Promise<string>
  onChange(state: AgyInstallState): void
  /** give up after this long (ms) */
  timeoutMs?: number
}

const INSTALL_TIMEOUT_MS = 5 * 60_000
const KEEP_LINES = 12

/** The last few non-empty lines of what the installer printed, without escape codes. */
export function tailOf(text: string, lines = KEEP_LINES): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
  return clean.slice(-lines).join('\n').slice(-2000)
}

const realDeps = (onChange: AgyInstallDeps['onChange']): AgyInstallDeps => ({
  platform: process.platform,
  spawn: (file, args) =>
    spawn(file, [...args], {
      cwd: tmpdir(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }),
  resolveCli: () => resolveAgyCliPath(undefined),
  onChange,
})

export class AgyInstaller {
  private current: AgyInstallState = { phase: 'idle' }
  private child: ChildProcess | null = null
  private readonly deps: AgyInstallDeps

  constructor(deps: AgyInstallDeps)
  constructor(onChange: AgyInstallDeps['onChange'])
  constructor(first: AgyInstallDeps | AgyInstallDeps['onChange']) {
    this.deps = typeof first === 'function' ? realDeps(first) : first
  }

  state(): AgyInstallState {
    return { ...this.current }
  }

  private set(next: AgyInstallState): void {
    this.current = next
    this.deps.onChange({ ...next })
  }

  /** Runs the installer; resolves with the final state (done or failed). One at a time. */
  start(): Promise<AgyInstallState> {
    if (this.current.phase === 'installing')
      return Promise.resolve({ phase: 'failed', error: 'busy' })
    const command = agyInstallCommand(this.deps.platform)
    if (!command) {
      this.set({ phase: 'failed', error: 'unsupported' })
      return Promise.resolve(this.state())
    }
    this.set({ phase: 'installing' })
    return new Promise<AgyInstallState>((resolve) => {
      let output = ''
      let settled = false
      const finish = (next: AgyInstallState): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        this.set(next)
        resolve(this.state())
      }
      const timer = setTimeout(() => {
        if (this.child) killProcessTree(this.child)
        finish({ phase: 'failed', error: 'timeout', output: tailOf(output) })
      }, this.deps.timeoutMs ?? INSTALL_TIMEOUT_MS)
      let child: ChildProcess
      try {
        child = this.deps.spawn(command.file, command.args)
      } catch {
        finish({ phase: 'failed', error: 'script-failed' })
        return
      }
      this.child = child
      const collect = (chunk: Buffer): void => {
        if (output.length < 200_000) output += chunk.toString('utf8')
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('error', () =>
        finish({ phase: 'failed', error: 'script-failed', output: tailOf(output) }),
      )
      child.on('close', (code) => {
        if (code !== 0) {
          finish({ phase: 'failed', error: 'script-failed', output: tailOf(output) })
          return
        }
        // the script says it worked: believe it only once `agy` can really be found
        void this.deps.resolveCli().then(
          () => finish({ phase: 'done' }),
          () => finish({ phase: 'failed', error: 'not-found-after', output: tailOf(output) }),
        )
      })
    })
  }

  cancel(): void {
    if (this.child) killProcessTree(this.child)
  }
}
