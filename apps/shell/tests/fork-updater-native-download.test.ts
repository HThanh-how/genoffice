import { EventEmitter } from 'node:events'
import { Readable, PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  request: vi.fn(),
  show: vi.fn(),
  push: vi.fn(),
  data: '',
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.1', getPath: () => mocks.data },
  net: { fetch: mocks.fetch, request: mocks.request },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}))
vi.mock('../src/main/updater', () => ({
  initialState: (version: string) => ({ version, strings: {} }),
}))
vi.mock('../src/main/app-message-box', () => ({ showAppMessageBox: vi.fn() }))
vi.mock('../src/main/update-window', () => ({
  showUpdateWindow: mocks.show,
  pushUpdateState: mocks.push,
  closeUpdateWindow: vi.fn(),
}))

let request: EventEmitter & {
  followRedirect: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}
beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  mocks.data = await mkdtemp(join(tmpdir(), 'native-update-'))
  request = Object.assign(new EventEmitter(), {
    followRedirect: vi.fn(),
    abort: vi.fn(),
    end: vi.fn(),
  })
  mocks.request.mockReturnValue(request)
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(mocks.data, { recursive: true, force: true })
})

async function startDownload() {
  const suffix =
    process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.AppImage'
  const url = `https://github.com/HThanh-how/genoffice/releases/download/v0.11.2/app${suffix}`
  const platform =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  mocks.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        tag_name: 'v0.11.2',
        assets: [
          {
            name: `GenOffice-${platform}-${process.arch}-setup${suffix}`,
            browser_download_url: url,
            digest: 'sha256:' + createHash('sha256').update('installer').digest('hex'),
          },
        ],
      }),
    ),
  )
  const { checkForkUpdates } = await import('../src/main/fork-updater')
  await checkForkUpdates({ kind: 'github', value: 'HThanh-how/genoffice' }, 'stable', () => null)
  mocks.show.mock.calls[0][2].onDownload()
  await vi.waitFor(() => expect(request.end).toHaveBeenCalledOnce())
  expect(mocks.request).toHaveBeenCalledWith({ url, redirect: 'manual' })
}

it('follows a validated signed CDN redirect and verifies the streamed installer', async () => {
  await startDownload()
  request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/app?sig=valid')
  expect(request.followRedirect).toHaveBeenCalledOnce()
  const response = Object.assign(Readable.from([Buffer.from('installer')]), {
    statusCode: 200,
    headers: {},
  })
  request.emit('response', response)
  await vi.waitFor(() =>
    expect(mocks.push).toHaveBeenCalledWith({ phase: 'downloaded', percent: 100 }),
  )
})

it('aborts an untrusted redirect before following it and removes temporary files', async () => {
  await startDownload()
  request.emit('redirect', 302, 'GET', 'https://attacker.example/app')
  expect(request.followRedirect).not.toHaveBeenCalled()
  expect(request.abort).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ phase: 'error' }))
  expect(await readdir(join(mocks.data, 'updates'))).toEqual([])
})

it('keeps the timeout through response headers and aborts an interrupted response', async () => {
  await startDownload()
  const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
  const clear = vi.spyOn(globalThis, 'clearTimeout')
  request.emit('response', response)
  expect(clear).not.toHaveBeenCalled()
  request.emit('error', new Error('connection interrupted'))
  expect(request.abort).toHaveBeenCalled()
  clear.mockRestore()
  await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ phase: 'error' }))
})
