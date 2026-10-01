import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { vi } from 'vitest'
import type { AgyFsDeps, AgyRunDeps } from '../../src/agy-cli'

// --- fake environment ---
export function fsDeps(
  platform: NodeJS.Platform,
  files: Record<string, { exec: boolean }>,
  extra: Partial<AgyFsDeps> = {},
): AgyFsDeps {
  return {
    platform,
    env: {},
    home: platform === 'win32' ? 'C:\\Users\\u' : '/home/u',
    isFile: async (p) => p in files,
    isExecutable: async (p) => files[p]?.exec === true,
    loginShellLookup: async () => undefined,
    ...extra,
  }
}

export class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  pid = 4242
  kill = vi.fn(() => true)
  stdinText = ''
  constructor() {
    super()
    this.stdin.on('data', (c: Buffer) => (this.stdinText += c.toString('utf8')))
  }
  emitLines(lines: string[]) {
    this.stdout.write(lines.join('\n') + '\n')
  }
  exit(code: number) {
    this.stdout.end()
    setImmediate(() => this.emit('close', code))
  }
  asChild() {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

export function runDeps(child: FakeChild, overrides: Partial<AgyRunDeps> = {}) {
  const dirs: string[] = []
  const written: Array<{ path: string; size: number }> = []
  const removed: string[] = []
  const spawned: Array<{ command: string; args: string[]; cwd: string }> = []
  const deps: AgyRunDeps = {
    ...fsDeps('win32', { 'C:\\agy\\agy.exe': { exec: true } }),
    spawn: (command, args, options) => {
      spawned.push({ command, args, cwd: options.cwd })
      return child.asChild()
    },
    killTree: vi.fn(),
    makeStagingDir: async () => {
      const dir = `C:\\tmp\\stage-${dirs.length}`
      dirs.push(dir)
      return dir
    },
    removeDir: async (dir) => {
      removed.push(dir)
    },
    writeFile: async (path, bytes) => {
      written.push({ path, size: bytes.byteLength })
    },
    ...overrides,
  }
  return { deps, dirs, written, removed, spawned }
}

export const CLI = 'C:\\agy\\agy.exe'
export const tick = () => new Promise((r) => setImmediate(r))
