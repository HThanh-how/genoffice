import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCX_ROUTE,
  ServiceRateLimitedError,
  XLSX_ROUTE,
  convertThroughService,
} from '../src/main/legacy-service'

const noPause = () => Promise.resolve()
const zip = new Uint8Array(200).map((_, i) => (i === 0 ? 0x50 : i === 1 ? 0x4b : 1))
const acceptZip = async (bytes: Uint8Array) => {
  if (bytes[0] !== 0x50) throw new Error('not a zip')
}

afterEach(() => vi.restoreAllMocks())

const reply = (status: number, body: Uint8Array | string = zip) =>
  new Response(typeof body === 'string' ? body : Buffer.from(body), { status })

describe('the conversion service', () => {
  it('posts to the route and content type of the format, to the endpoint given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200))
    const bytes = await convertThroughService(
      new Uint8Array([1, 2, 3]),
      'https://svc.example',
      XLSX_ROUTE,
      acceptZip,
      noPause,
    )
    expect(bytes).toHaveLength(200)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://svc.example/v1/convert/xlsx')
    expect((init as RequestInit).headers).toEqual({ 'Content-Type': 'application/vnd.ms-excel' })
    expect(DOCX_ROUTE.path).toBe('/v1/convert/docx')
  })

  it('stops at the hourly limit instead of asking again, and says so', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(429, 'limit'))
    await expect(
      convertThroughService(
        new Uint8Array([1]),
        'https://svc.example',
        XLSX_ROUTE,
        acceptZip,
        noPause,
      ),
    ).rejects.toBeInstanceOf(ServiceRateLimitedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks again after a busy answer or a dropped connection', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(503, 'busy'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(200))
    const bytes = await convertThroughService(
      new Uint8Array([1]),
      'https://svc.example',
      XLSX_ROUTE,
      acceptZip,
      noPause,
    )
    expect(bytes).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('gives up on a file the service refuses, and on a reply that is not a document', async () => {
    const refused = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(422, 'bad'))
    expect(
      await convertThroughService(
        new Uint8Array([1]),
        'https://svc.example',
        XLSX_ROUTE,
        acceptZip,
        noPause,
      ),
    ).toBeNull()
    expect(refused).toHaveBeenCalledTimes(1)
    refused.mockReset()
    refused.mockResolvedValue(reply(200, 'not a zip at all'))
    expect(
      await convertThroughService(
        new Uint8Array([1]),
        'https://svc.example',
        XLSX_ROUTE,
        acceptZip,
        noPause,
      ),
    ).toBeNull()
  })

  it('never sends a file over an insecure or malformed address', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const endpoint of ['http://svc.example', 'ftp://svc.example', 'not a url']) {
      expect(
        await convertThroughService(new Uint8Array([1]), endpoint, XLSX_ROUTE, acceptZip, noPause),
      ).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
