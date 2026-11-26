// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  windows: [] as { webContents: { id: number }; destroyed: boolean }[],
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  native: async () => ({ response: 0, checkboxChecked: false }),
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow extends EventEmitter {
    static getFocusedWindow = () => null
    static fromWebContents = () => null
    webContents = { id: fake.windows.length + 1 }
    destroyed = false
    constructor() {
      super()
      fake.windows.push(this)
    }
    isDestroyed = () => this.destroyed
    destroy = () => {
      this.destroyed = true
    }
    show = () => {}
    showInactive = () => {}
    getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })
    setPosition = () => {}
    setFocusable = () => {}
    loadFile = async () => {}
    loadURL = async () => {}
  }
  return {
    BrowserWindow,
    dialog: { showMessageBox: fake.native, showMessageBoxSync: () => 0 },
    ipcMain: {
      handle: (channel: string, h: (event: unknown, ...args: unknown[]) => unknown) =>
        fake.handlers.set(channel, h),
      on: () => {},
    },
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    app: { getAppPath: () => '' },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  }
})

const electron = await import('electron')
const { showAppMessageBox, showUpdateStatusMessageBox } =
  await import('../src/main/app-message-box')
const { installThemedDialogs } = await import('@genoffice/electron-utils/message-box')
const { FEEDBACK_CHANNELS } = await import('../src/shared/feedback-api')

/** the user presses button `response` in the box that is open now */
const press = async (response: number) => {
  await vi.waitFor(() => expect(fake.windows.at(-1)?.destroyed).toBe(false))
  const box = fake.windows.at(-1)!
  fake.handlers.get(FEEDBACK_CHANNELS.respond)!(
    { sender: { id: box.webContents.id } },
    { response, checkboxChecked: false },
  )
}
const options = {
  type: 'question' as const,
  message: 'Download?',
  buttons: ['Download', 'Not now'],
}

beforeEach(() => {
  ;(electron.dialog as { showMessageBox: unknown }).showMessageBox = fake.native
})

it('works once installed as the dialog of the whole app, as the shell does at startup', async () => {
  installThemedDialogs(showAppMessageBox as never)
  expect(electron.dialog.showMessageBox).toBe(showAppMessageBox)
  const before = fake.windows.length
  const answer = showAppMessageBox(options)
  await press(1)
  expect(await answer).toEqual({ response: 1, checkboxChecked: false })
  expect(fake.windows).toHaveLength(before + 1)
  const update = showUpdateStatusMessageBox(options)
  await press(0)
  expect(await update).toEqual({ response: 0, checkboxChecked: false })
})

it('a dialog called through Electron reaches the same box', async () => {
  ;(electron.dialog as { showMessageBox: unknown }).showMessageBox = showAppMessageBox
  const answer = electron.dialog.showMessageBox(options)
  await press(0)
  expect(await answer).toEqual({ response: 0, checkboxChecked: false })
})

it('still hands the call to a box someone else installed (a test spy)', async () => {
  const spy = vi.fn(async () => ({ response: 1, checkboxChecked: false }))
  ;(electron.dialog as { showMessageBox: unknown }).showMessageBox = spy
  const before = fake.windows.length
  expect(await showAppMessageBox(options)).toEqual({ response: 1, checkboxChecked: false })
  expect(await showUpdateStatusMessageBox(options)).toEqual({ response: 1, checkboxChecked: false })
  expect(spy).toHaveBeenCalledTimes(2)
  expect(fake.windows).toHaveLength(before)
})

it('opens its own box while the native one is in place', async () => {
  const answer = showAppMessageBox(options)
  await press(0)
  expect(await answer).toEqual({ response: 0, checkboxChecked: false })
})
