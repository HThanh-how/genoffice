import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { convertWithService } from '../src/main/legacy-doc'

const noPause = () => Promise.resolve()
const source = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3])

afterEach(() => vi.restoreAllMocks())

describe('asking the conversion service again', () => {
  it('survives a dropped connection', async () => {
    const docx = await buildBlankDocx()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(Buffer.from(docx), { status: 200 }))
    const bytes = await convertWithService(source, 'https://svc.example', noPause)
    expect(bytes).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('survives a busy service and a slow try', async () => {
    const docx = await buildBlankDocx()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response(Buffer.from(docx), { status: 200 }))
    expect(await convertWithService(source, 'https://svc.example', noPause)).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('pauses longer between each new try', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const pauses: number[] = []
    const result = await convertWithService(source, 'https://svc.example', (ms) => {
      pauses.push(ms)
      return Promise.resolve()
    })
    expect(result).toBeNull()
    expect(pauses).toEqual([500, 2000, 4500])
  })

  it('does not ask again when the service says the file itself is bad', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"detail":"cannot convert"}', { status: 422 }))
    expect(await convertWithService(source, 'https://svc.example', noPause)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after four tries and refuses a service that is not https', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('x', { status: 502 }))
    expect(await convertWithService(source, 'https://svc.example', noPause)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    fetchMock.mockClear()
    expect(await convertWithService(source, 'http://svc.example', noPause)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
