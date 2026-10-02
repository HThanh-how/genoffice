import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  show: vi.fn(),
  push: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  dialog: vi.fn(),
  quit: vi.fn(),
  data: '',
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.1', getPath: () => mocks.data, quit: mocks.quit },
  net: { fetch: mocks.fetch },
  shell: { openPath: mocks.open, openExternal: vi.fn() },
  dialog: { showMessageBox: mocks.dialog },
}))
vi.mock('../src/main/updater', () => ({
  initialState: (version: string) => ({ version, strings: {} }),
}))
vi.mock('../src/main/update-window', () => ({
  showUpdateWindow: mocks.show,
  pushUpdateState: mocks.push,
  closeUpdateWindow: mocks.close,
}))

const realPlatform = process.platform
function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  mocks.data = await mkdtemp(join(tmpdir(), 'genoffice-updater-restart-'))
  mocks.open.mockResolvedValue('')
})
afterEach(async () => {
  platform(realPlatform)
  await rm(mocks.data, { recursive: true, force: true })
})

function fakeSpawn(outcome: 'spawn' | 'error') {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  const run = vi.fn(() => {
    queueMicrotask(() => child.emit(outcome, new Error('EPERM')))
    return child
  })
  return { run: run as never, child, calls: run }
}

describe('applying an update by a restart', () => {
  it('runs the installer silently, asking it to start the new version, then quits', async () => {
    const { installAndRestart } = await import('../src/main/fork-updater')
    const quit = vi.fn()
    const spawned = fakeSpawn('spawn')

    expect(
      await installAndRestart('C:\\u\\GenOffice-0.11.2.exe', {
        platform: 'win32',
        spawnInstaller: spawned.run,
        quit,
      }),
    ).toBe(true)

    expect(spawned.calls).toHaveBeenCalledWith(
      'C:\\u\\GenOffice-0.11.2.exe',
      ['/S', '--updated', '--force-run'],
      expect.objectContaining({ detached: true, windowsHide: true, stdio: 'ignore' }),
    )
    expect(spawned.child.unref).toHaveBeenCalled()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('keeps the app running and says so when the installer could not be started', async () => {
    const { installAndRestart } = await import('../src/main/fork-updater')
    const quit = vi.fn()
    expect(
      await installAndRestart('C:\\u\\x.exe', {
        platform: 'win32',
        spawnInstaller: fakeSpawn('error').run,
        quit,
      }),
    ).toBe(false)
    expect(quit).not.toHaveBeenCalled()
  })

  it('is for Windows only', async () => {
    const { installAndRestart } = await import('../src/main/fork-updater')
    const spawned = fakeSpawn('spawn')
    expect(
      await installAndRestart('/tmp/x.dmg', { platform: 'darwin', spawnInstaller: spawned.run }),
    ).toBe(false)
    expect(spawned.calls).not.toHaveBeenCalled()
  })
})

describe('the background check', () => {
  async function background(checksum: string, version = '0.11.2') {
    platform('win32')
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version,
          assets: [
            {
              platform: 'win32',
              arch: process.arch,
              url: 'https://example.com/app.exe',
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
      { background: true },
    )
  }
  const good = createHash('sha256').update('installer bytes').digest('hex')

  it('downloads quietly and shows the restart card only once the update is ready', async () => {
    await background(good)
    expect(mocks.dialog).not.toHaveBeenCalled()
    expect(mocks.show).toHaveBeenCalledOnce()
    expect(mocks.show.mock.calls[0]![1]).toMatchObject({ phase: 'downloaded', version: '0.11.2' })
    expect(mocks.show.mock.calls[0]![1].strings.install).toMatch(/restart|khởi động lại/i)
  })

  it('stays silent when there is nothing new, nothing usable, or the download is bad', async () => {
    await background(good, '0.11.1') // the version that is running
    await background('f'.repeat(64)) // a download whose checksum does not match
    expect(mocks.show).not.toHaveBeenCalled()
    expect(mocks.dialog).not.toHaveBeenCalled()

    mocks.fetch.mockRejectedValue(new Error('offline'))
    const { checkForkUpdates } = await import('../src/main/fork-updater')
    await checkForkUpdates({ kind: 'github', value: 'a/b' }, 'stable', () => null, {
      background: true,
    })
    expect(mocks.dialog).not.toHaveBeenCalled()
  })

  it("leaves macOS alone: nothing is downloaded behind the person's back there", async () => {
    platform('darwin')
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: '0.11.2',
          assets: [
            {
              platform: 'darwin',
              arch: process.arch,
              url: 'https://example.com/a.dmg',
              sha256: good,
            },
          ],
        }),
      ),
    )
    const { checkForkUpdates } = await import('../src/main/fork-updater')
    await checkForkUpdates(
      { kind: 'manifest', value: 'https://example.com/u.json' },
      'stable',
      () => null,
      {
        background: true,
      },
    )
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.show).not.toHaveBeenCalled()
  })
})
