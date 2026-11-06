import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  handler: undefined as undefined | ((request: Request) => Promise<Response>),
}))
vi.mock('electron', () => ({
  protocol: {
    handle: (_scheme: string, fn: typeof mock.handler) => {
      mock.handler = fn
    },
  },
  dialog: {},
}))
vi.mock('../src/main/app-settings', () => ({
  readAppSettings: () => ({}),
  writeAppSettings: () => {},
}))
import { registerLiveBackground } from '../src/main/fork/live-background'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})
describe('keyed media protocol', () => {
  it('serves only registered files, supports ranges, and revokes a source', async () => {
    dir = mkdtempSync(join(process.cwd(), 'opening-media-test-'))
    const path = join(dir, 'movie.mp4')
    writeFileSync(path, '0123456789')
    const controller = registerLiveBackground({
      ipcMain: { handle: vi.fn() },
      settingsPath: () => '',
      parentWindow: () => null,
      broadcast: () => {},
    })
    controller.installProtocol()
    expect(await controller.setSelectedSource('../escape', path)).toBeNull()
    expect(await controller.setSelectedSource('file', path)).toBeNull()
    const media = await controller.setSelectedSource('card1', path)
    expect(media?.kind).toBe('video')
    const request = (url: string, range?: string) =>
      mock.handler!({ url, method: 'GET', headers: new Headers(range ? { range } : {}) } as Request)
    const part = await request(media!.url, 'bytes=2-4')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await part.text()).toBe('234')
    expect((await request(media!.url, 'bytes=99-100')).status).toBe(416)
    for (const url of [
      'genoffice-bg://card2/main',
      'genoffice-bg://card1/../main',
      'genoffice-bg://card1/%2e%2e/main',
      'genoffice-bg://card1/secret',
      'genoffice-bg://user@card1/main',
    ])
      expect((await request(url)).status).toBe(404)
    await controller.setSelectedSource('card1', '')
    expect(controller.getSelectedSource('card1')).toBeNull()
    expect((await request(media!.url)).status).toBe(404)
  })
})
