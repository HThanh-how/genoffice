import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  show: vi.fn(),
  push: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  dialog: vi.fn(),
  data: '',
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.1', getPath: () => mocks.data },
  net: { fetch: mocks.fetch },
  shell: { openPath: mocks.open, openExternal: vi.fn() },
  dialog: { showMessageBox: mocks.dialog },
}))
vi.mock('../src/main/updater', () => ({
  initialState: (version: string) => ({ version, strings: {} }),
}))
vi.mock('../src/main/app-message-box', () => ({ showAppMessageBox: mocks.dialog }))
vi.mock('../src/main/update-window', () => ({
  showUpdateWindow: mocks.show,
  pushUpdateState: mocks.push,
  closeUpdateWindow: mocks.close,
}))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  mocks.data = await mkdtemp(join(tmpdir(), 'genoffice-updater-test-'))
  mocks.open.mockResolvedValue('')
  mocks.dialog.mockResolvedValue({ response: 0 })
})
afterEach(async () => {
  await rm(mocks.data, { recursive: true, force: true })
})

async function showUpdate(checksum: string) {
  const extension =
    process.platform === 'darwin' ? '.dmg' : process.platform === 'win32' ? '.exe' : '.AppImage'
  mocks.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        version: '0.11.2',
        assets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `https://example.com/app${extension}`,
            sha256: checksum,
          },
        ],
      }),
    ),
  )
  mocks.fetch.mockResolvedValueOnce(new Response('installer bytes'))
  const { checkForkUpdates } = await import('../src/main/fork-updater')
  await checkForkUpdates(
    { kind: 'manifest', value: 'https://example.com/updates.json' },
    'stable',
    () => null,
  )
  return mocks.show.mock.calls[0][2] as { onDownload(): void; onInstall(): void }
}

it('downloads, verifies bytes, and only opens a verified installer after explicit install', async () => {
  const actions = await showUpdate(createHash('sha256').update('installer bytes').digest('hex'))
  actions.onDownload()
  await vi.waitFor(() =>
    expect(mocks.push).toHaveBeenCalledWith({ phase: 'downloaded', percent: 100 }),
  )
  expect(mocks.open).not.toHaveBeenCalled()
  actions.onInstall()
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  expect(await readFile(mocks.open.mock.calls[0][0], 'utf8')).toBe('installer bytes')
})

it('checksum mismatch deletes the download and cannot open an installer', async () => {
  const actions = await showUpdate('a'.repeat(64))
  actions.onDownload()
  await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ phase: 'error' }))
  actions.onInstall()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(await readdir(join(mocks.data, 'updates'))).toEqual([])
})

it('reports network failure without presenting an update or claiming the app is current', async () => {
  mocks.fetch.mockRejectedValue(new Error('network failed'))
  const { checkForkUpdates } = await import('../src/main/fork-updater')
  await checkForkUpdates({ kind: 'github', value: 'HThanh-how/genoffice' }, 'stable', () => null)
  expect(mocks.dialog.mock.calls[0][0].type).toBe('warning')
  expect(mocks.show).not.toHaveBeenCalled()
})
