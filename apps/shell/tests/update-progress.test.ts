import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  startUpdateProgress,
  updateProgressScript,
  updateWords,
} from '../src/main/fork/update-progress'

const options = {
  installerPid: 4321,
  exePath: "C:\\Users\\O'Neil\\AppData\\Local\\Programs\\GenOffice\\GenOffice.exe",
  lang: 'vi',
}

describe('the "Updating…" card shown while the installer runs', () => {
  it('speaks Vietnamese or English', () => {
    expect(updateWords('vi').title).toBe('Đang cập nhật GenOffice…')
    expect(updateWords('en').title).toBe('Updating GenOffice…')
    expect(updateWords('ja')).toEqual(updateWords('en'))
  })

  it('watches the installer it was given and starts the app if the installer does not', () => {
    const script = updateProgressScript(options)
    expect(script).toContain('$installerPid = 4321')
    expect(script).toContain('Get-Process -Id $installerPid')
    expect(script).toContain('Start-Process -FilePath $exe')
    // a path with an apostrophe is quoted, not allowed to end the string
    expect(script).toContain(
      "'C:\\Users\\O''Neil\\AppData\\Local\\Programs\\GenOffice\\GenOffice.exe'",
    )
    // it never stays on screen for ever
    expect(script).toContain('TotalMinutes -gt 10')
  })

  it('refuses a process id that is not a plain positive number', () => {
    expect(() => updateProgressScript({ ...options, installerPid: -1 })).toThrow()
    expect(() => updateProgressScript({ ...options, installerPid: Number.NaN })).toThrow()
  })

  it('starts a hidden, detached PowerShell with the script encoded, and reports a failure to start', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const run = vi.fn(() => child)
    expect(startUpdateProgress(options, run as never)).toBe(true)
    const [file, args, spawnOptions] = run.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ]
    expect(file).toBe('powershell.exe')
    expect(args).toContain('-EncodedCommand')
    expect(Buffer.from(args.at(-1)!, 'base64').toString('utf16le')).toBe(
      updateProgressScript(options),
    )
    expect(spawnOptions).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalled()

    const broken = vi.fn(() => {
      throw new Error('ENOENT')
    })
    expect(startUpdateProgress(options, broken as never)).toBe(false)
  })
})
