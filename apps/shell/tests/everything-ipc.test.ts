import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

interface MockDialogOutcome {
  canceled: boolean
  filePaths: string[]
}

function createMockDialog(initial: MockDialogOutcome = { canceled: false, filePaths: [] }) {
  let outcome = initial
  return {
    setOutcome(next: MockDialogOutcome) {
      outcome = next
    },
    dialogProvider: {
      showOpenDialog: async () => outcome,
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ev-ipc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Everything settings channels', () => {
  it('are registered before the controller exists, and answer once it does', async () => {
    // the app registers its channels when it loads and builds the controller later
    let controller: EverythingController | null = null
    const { ipcMain, call } = fakeIpc()
    const mockDialog = createMockDialog()
    registerEverythingIpc(ipcMain, () => controller, mockDialog.dialogProvider)

    expect(call(DOCUMENT_INDEX_CHANNELS.getEverything)).toMatchObject({
      enabled: true,
      found: false,
    })
    expect(() => call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: false })).toThrow(
      'not ready',
    )
    await expect(call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)).rejects.toThrow(
      'not ready',
    )

    controller = createEverything(dir)
    const exeName = process.platform === 'win32' ? 'es.exe' : 'es'
    const fakeExe = join(dir, exeName)
    writeFileSync(fakeExe, '')

    expect(call(DOCUMENT_INDEX_CHANNELS.getEverything)).toMatchObject({ enabled: true })

    mockDialog.setOutcome({ canceled: false, filePaths: [` ${fakeExe} `] })
    const state = await call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)
    expect(state).toMatchObject({ enabled: true, path: fakeExe })

    expect(call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: false })).toMatchObject({
      enabled: false,
      path: fakeExe,
    })
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

  it('refuses custom path string via setEverything but allows resetting it', () => {
    const { ipcMain, call } = fakeIpc()
    const controller = createEverything(dir)
    registerEverythingIpc(ipcMain, () => controller)

    const exeName = process.platform === 'win32' ? 'es.exe' : 'es'
    const fakeExe = join(dir, exeName)
    writeFileSync(fakeExe, '')

    // Custom path string via setEverything is rejected
    expect(() =>
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: fakeExe }),
    ).toThrow('Custom executable path can only be configured via system file picker')

    // But empty string / whitespace is allowed to reset path
    controller.set({ enabled: true, path: fakeExe })
    expect(controller.state().path).toBe(fakeExe)

    expect(
      call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: true, path: '   ' }),
    ).toMatchObject({ enabled: true })
    expect(controller.state().path).toBeUndefined()
    expect(createEverything(dir).state().path).toBeUndefined()

    // When path is undefined, it preserves existing path and toggles enabled
    controller.set({ enabled: true, path: fakeExe })
    expect(call(DOCUMENT_INDEX_CHANNELS.setEverything, { enabled: false })).toMatchObject({
      enabled: false,
      path: fakeExe,
    })
  })

  describe('chooseEverythingExecutable', () => {
    it('updates path and enables Everything when valid executable is chosen', async () => {
      const { ipcMain, call } = fakeIpc()
      const controller = createEverything(dir)
      const exeName = process.platform === 'win32' ? 'es.exe' : 'es'
      const fakeExe = join(dir, exeName)
      writeFileSync(fakeExe, '')

      const mockDialog = createMockDialog({ canceled: false, filePaths: [fakeExe] })
      registerEverythingIpc(ipcMain, () => controller, mockDialog.dialogProvider)

      const result = await call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)
      expect(result).toMatchObject({ enabled: true, path: fakeExe })
      expect(controller.state()).toMatchObject({ enabled: true, path: fakeExe })
    })

    it('preserves existing state when dialog is canceled or empty', async () => {
      const { ipcMain, call } = fakeIpc()
      const controller = createEverything(dir)
      const mockDialog = createMockDialog({ canceled: true, filePaths: [] })
      registerEverythingIpc(ipcMain, () => controller, mockDialog.dialogProvider)

      const state1 = await call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)
      expect(state1).toMatchObject({ enabled: true })
      expect(state1).not.toHaveProperty('path')

      // Empty filePaths without canceled flag
      mockDialog.setOutcome({ canceled: false, filePaths: [] })
      const state2 = await call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)
      expect(state2).toMatchObject({ enabled: true })
      expect(state2).not.toHaveProperty('path')
    })

    it('enforces security restrictions on chosen executable', async () => {
      const { ipcMain, call } = fakeIpc()
      const controller = createEverything(dir)
      const mockDialog = createMockDialog()
      registerEverythingIpc(ipcMain, () => controller, mockDialog.dialogProvider)

      const exeName = process.platform === 'win32' ? 'es.exe' : 'es'
      const fakeExe = join(dir, exeName)
      writeFileSync(fakeExe, '')

      // Rejects relative path
      mockDialog.setOutcome({ canceled: false, filePaths: [exeName] })
      await expect(call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)).rejects.toThrow(
        'Executable path must be absolute',
      )

      // Rejects control characters
      mockDialog.setOutcome({ canceled: false, filePaths: [`${fakeExe}\0`] })
      await expect(call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)).rejects.toThrow(
        'Invalid characters in executable path',
      )
      mockDialog.setOutcome({ canceled: false, filePaths: [`${fakeExe}\r\ntest`] })
      await expect(call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)).rejects.toThrow(
        'Invalid characters in executable path',
      )

      // Rejects mismatched executable name
      const badExe = join(dir, 'malicious.exe')
      writeFileSync(badExe, '')
      mockDialog.setOutcome({ canceled: false, filePaths: [badExe] })
      await expect(call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)).rejects.toThrow(
        `Executable must be ${exeName}`,
      )

      // Rejects non-existent executable file
      const missingExe = join(dir, 'subdir', exeName)
      mockDialog.setOutcome({ canceled: false, filePaths: [missingExe] })
      await expect(call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)).rejects.toThrow(
        'Configured executable does not exist or is not a file',
      )

      // Rejects directory even if named es.exe
      const fakeDirAsExe = join(dir, 'folder-' + exeName, exeName)
      mkdirSync(join(dir, 'folder-' + exeName))
      mkdirSync(fakeDirAsExe)
      mockDialog.setOutcome({ canceled: false, filePaths: [fakeDirAsExe] })
      await expect(call(DOCUMENT_INDEX_CHANNELS.chooseEverythingExecutable)).rejects.toThrow(
        'Configured executable does not exist or is not a file',
      )
    })
  })
})
