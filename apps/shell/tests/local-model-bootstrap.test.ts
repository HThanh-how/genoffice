import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ready: Promise.resolve() as Promise<void>,
  settings: { provider: 'local', providers: { local: { local: { autoDownload: true } } } },
  quit: () => {},
  download: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  network: vi.fn(async () => 'online'),
  /** what is on disk at startup: 'paused' = a download that was begun */
  status: 'paused',
  ask: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => '/virtual/local-model-test',
    whenReady: () => state.ready,
    on: (_event: string, listener: () => void) => {
      state.quit = listener
    },
  },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  net: { isOnline: () => true },
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<object>()),
  readFile: async () => JSON.stringify(state.settings),
}))
vi.mock('@genoffice/ai-provider', () => ({
  defaultAiSettings: () => state.settings,
  resolveAiSettings: (stored: unknown) => stored,
  activeProvider: (settings: { provider: string }) => settings.provider,
}))
vi.mock('@genoffice/electron-utils/local-chat', () => ({
  registerLocalChat: vi.fn(),
  shutdownLocalChat: vi.fn(),
}))
vi.mock('../src/main/local-model/network', () => ({ downloadNetwork: state.network }))
vi.mock('../src/main/app-message-box', () => ({ showAppMessageBox: state.ask }))
vi.mock('../src/main/local-model/manager', () => ({
  LocalModelManager: class {
    state = { status: state.status, percent: 0 }
    refresh = async () => {}
    download = state.download
    cancel = state.cancel
  },
}))
import { registerLocalModel } from '../src/main/local-model/ipc'

beforeEach(() => {
  vi.clearAllMocks()
  state.settings = { provider: 'local', providers: { local: { local: { autoDownload: true } } } }
  state.ready = Promise.resolve()
  state.network.mockResolvedValue('online')
  state.status = 'paused'
})

it('resumes a download that was begun, only after Electron is ready', async () => {
  let ready!: () => void
  state.ready = new Promise((resolve) => {
    ready = resolve
  })
  registerLocalModel(() => 'vi')
  await Promise.resolve()
  expect(state.download).not.toHaveBeenCalled()
  ready()
  await vi.waitFor(() => expect(state.download).toHaveBeenCalledOnce())
})

it('never starts a new download at startup, and asks nothing there', async () => {
  state.status = 'missing'
  registerLocalModel(() => 'en')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(state.network).not.toHaveBeenCalled()
  expect(state.download).not.toHaveBeenCalled()
  expect(state.ask).not.toHaveBeenCalled()
})

it('preserves a saved cloud choice and the auto-download opt-out', async () => {
  state.settings.provider = 'gemini'
  registerLocalModel(() => 'en')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(state.download).not.toHaveBeenCalled()
  state.settings.provider = 'local'
  state.settings.providers.local.local.autoDownload = false
  registerLocalModel(() => 'en')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(state.download).not.toHaveBeenCalled()
})

it('does not revive a download after quit while a network probe is pending', async () => {
  let network!: (value: string) => void
  state.network.mockReturnValue(
    new Promise((resolve) => {
      network = resolve
    }),
  )
  registerLocalModel(() => 'en')
  await vi.waitFor(() => expect(state.network).toHaveBeenCalledOnce())
  state.quit()
  network('online')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(state.download).not.toHaveBeenCalled()
  expect(state.cancel).toHaveBeenCalledOnce()
})
