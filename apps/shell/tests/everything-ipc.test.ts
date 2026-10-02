import { mkdtempSync, rmSync } from 'node:fs'
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
    expect(call(DOCUMENT_INDEX_CHANNELS.getEverything)).toMatchObject({ enabled: true })
    expect(
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: false, path: ' F:\\t\\es.exe ' }),
    ).toMatchObject({ enabled: false, path: 'F:\\t\\es.exe' })
    // and it is remembered by a fresh controller (the next start)
    expect(createEverything(dir).state()).toMatchObject({ enabled: false, path: 'F:\\t\\es.exe' })
  })

  it('rejects a malformed change', () => {
    const { ipcMain, call } = fakeIpc()
    registerEverythingIpc(ipcMain, () => createEverything(dir))
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: 'yes' })).toThrow()
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: 5 })).toThrow()
  })
})
