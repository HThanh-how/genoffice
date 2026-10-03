import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import {
  AGY_INSTALL_URL_POSIX,
  AGY_INSTALL_URL_WINDOWS,
  AgyInstaller,
  agyInstallCommand,
  tailOf,
  type AgyInstallDeps,
} from '../src/agy-install'

class FakeInstall extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 77
  kill = vi.fn()
}

function rig(
  options: { code?: number; cli?: 'found' | 'missing'; platform?: NodeJS.Platform } = {},
) {
  const child = new FakeInstall()
  const states: string[] = []
  const spawn = vi.fn(() => child as unknown as ChildProcess)
  const deps: AgyInstallDeps = {
    platform: options.platform ?? 'win32',
    spawn,
    resolveCli: async () => {
      if (options.cli === 'missing') throw new Error('not found')
      return 'C:\\Local\\agy\\bin\\agy.exe'
    },
    onChange: (state) => states.push(state.phase),
    timeoutMs: 50,
  }
  const installer = new AgyInstaller(deps)
  const finish = (code: number): void => void setTimeout(() => child.emit('close', code), 5)
  return { installer, child, states, spawn, finish, code: options.code ?? 0 }
}

describe("the Antigravity CLI installer (Google's own script)", () => {
  it('runs the documented script for this platform with a fixed command line', () => {
    const windows = agyInstallCommand('win32')!
    expect(windows.file).toBe('powershell.exe')
    expect(windows.args.at(-1)).toBe(`irm ${AGY_INSTALL_URL_WINDOWS} | iex`)
    expect(AGY_INSTALL_URL_WINDOWS).toBe('https://antigravity.google/cli/install.ps1')
    expect(agyInstallCommand('darwin')).toEqual({
      file: '/bin/bash',
      args: ['-c', `curl -fsSL ${AGY_INSTALL_URL_POSIX} | bash`],
    })
    expect(AGY_INSTALL_URL_POSIX).toBe('https://antigravity.google/cli/install.sh')
    expect(agyInstallCommand('freebsd')).toBeNull()
  })

  it('is done only once agy can really be found afterwards', async () => {
    const { installer, finish, states, spawn } = rig()
    const result = installer.start()
    finish(0)
    expect(await result).toEqual({ phase: 'done' })
    expect(states).toEqual(['installing', 'done'])
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('does not believe a script that succeeded but left no agy behind', async () => {
    const { installer, finish } = rig({ cli: 'missing' })
    const result = installer.start()
    finish(0)
    expect(await result).toMatchObject({ phase: 'failed', error: 'not-found-after' })
  })

  it('reports a failing script with the last lines it printed', async () => {
    const { installer, finish, child } = rig()
    const result = installer.start()
    child.stderr.emit('data', Buffer.from('\u001b[31mcurl: (6) Could not resolve host\u001b[0m\n'))
    finish(1)
    const state = await result
    expect(state).toMatchObject({ phase: 'failed', error: 'script-failed' })
    expect(state.output).toBe('curl: (6) Could not resolve host')
  })

  it('gives up on an installer that never ends, and refuses a second one at the same time', async () => {
    const { installer, child } = rig()
    const first = installer.start()
    expect(await installer.start()).toMatchObject({ phase: 'failed', error: 'busy' })
    expect(await first).toMatchObject({ phase: 'failed', error: 'timeout' })
    // Windows kills the tree through taskkill, not child.kill()
    if (process.platform !== 'win32') expect(child.kill).toHaveBeenCalled()
  })

  it('says so on a platform it has no installer for', async () => {
    const { installer, spawn } = rig({ platform: 'freebsd' })
    expect(await installer.start()).toMatchObject({ phase: 'failed', error: 'unsupported' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps only the tail of long output', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(tailOf(text, 3)).toBe('line 37\nline 38\nline 39')
  })
})
