import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'
import {
  createEverything,
  registerEverythingIpc,
  type EverythingController,
} from '../src/main/fork/everything-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc(): { ipcMain: IpcMain; call: (channel: string, ...args: unknown[]) => unknown } {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
  return {
    ipcMain: ipcMain as unknown as IpcMain,
    call: (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler registered for ${channel}`)
      return handler({}, ...args)
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ev-ipc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Everything settings channels', () => {
  it('are registered before the controller exists, and answer once it does', () => {
    // the app registers its channels when it loads and builds the controller later
    let controller: EverythingController | null = null
    const { ipcMain, call } = fakeIpc()
    registerEverythingIpc(ipcMain, () => controller)

    expect(call(DOCUMENT_INDEX_CHANNELS.getEverything)).toMatchObject({
      enabled: true,
      found: false,
    })
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: false })).toThrow(
      'not ready',
    )

    controller = createEverything(dir)
    const exeName = process.platform === 'win32' ? 'es.exe' : 'es'
    const fakeExe = join(dir, exeName)
    writeFileSync(fakeExe, '')

    expect(call(DOCUMENT_INDEX_CHANNELS.getEverything)).toMatchObject({ enabled: true })
    expect(
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: false, path: ` ${fakeExe} ` }),
    ).toMatchObject({ enabled: false, path: fakeExe })
    // and it is remembered by a fresh controller (the next start)
    expect(createEverything(dir).state()).toMatchObject({ enabled: false, path: fakeExe })
  })

  it('rejects a malformed change', () => {
    const { ipcMain, call } = fakeIpc()
    registerEverythingIpc(ipcMain, () => createEverything(dir))
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: 'yes' })).toThrow(
      'Invalid Everything setting',
    )
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: 5 })).toThrow(
      'Invalid Everything path',
    )
  })

  it('enforces security restrictions on custom executable paths', () => {
    const { ipcMain, call } = fakeIpc()
    registerEverythingIpc(ipcMain, () => createEverything(dir))

    const exeName = process.platform === 'win32' ? 'es.exe' : 'es'
    const fakeExe = join(dir, exeName)
    writeFileSync(fakeExe, '')

    // Rejects relative path
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: exeName })).toThrow(
      'Executable path must be absolute',
    )

    // Rejects control characters
    expect(() =>
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: `${fakeExe}\0` }),
    ).toThrow('Invalid characters in executable path')
    expect(() =>
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: `${fakeExe}\r\ntest` }),
    ).toThrow('Invalid characters in executable path')

    // Rejects mismatched executable name
    const badExe = join(dir, 'malicious.exe')
    writeFileSync(badExe, '')
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: badExe })).toThrow(
      `Executable must be ${exeName}`,
    )

    // Rejects non-existent executable file
    const missingExe = join(dir, 'subdir', exeName)
    expect(() =>
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: missingExe }),
    ).toThrow('Configured executable does not exist or is not a file')

    // Accepts valid executable
    expect(
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: fakeExe }),
    ).toMatchObject({ enabled: true, path: fakeExe })

    // Preserves path when path is undefined
    expect(call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: false })).toMatchObject({
      enabled: false,
      path: fakeExe,
    })

    // Clears custom path when empty string is provided
    expect(call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: '   ' })).toMatchObject({
      enabled: true,
    })
    expect(createEverything(dir).state().path).toBeUndefined()
  })
})
