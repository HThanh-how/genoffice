import { readFile } from 'node:fs/promises'
import { openPptx } from '@genoffice/pptx-engine'

const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** Convert only genuine legacy PowerPoint files. The caller writes a new .pptx copy. */
export async function convertLegacyPpt(filePath: string, endpoint: string): Promise<Uint8Array> {
  if (!/\.ppt$/i.test(filePath)) throw new Error('Expected a .ppt file')
  const source = await readFile(filePath)
  if (!source.length || source.length > MAX_INPUT_BYTES) {
    throw new Error('The .ppt file is empty or exceeds the 20 MB import limit')
  }
  if (!source.subarray(0, 8).equals(CFB_MAGIC)) throw new Error('Invalid legacy .ppt file')
  const url = new URL('/v1/convert/pptx', endpoint)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new Error('The conversion service must use HTTPS')
  }
  let lastError: Error = new Error('The conversion service is unavailable')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.ms-powerpoint' },
        body: source,
        signal: AbortSignal.timeout(55_000),
      })
      if (!response.ok) {
        lastError = new Error(`Conversion service returned ${response.status}`)
        if (![502, 503, 504].includes(response.status)) break
      } else {
        const length = Number(response.headers.get('content-length'))
        if (Number.isFinite(length) && length > MAX_OUTPUT_BYTES)
          throw new Error('Converted file is too large')
        if (!response.body) throw new Error('Empty conversion response')
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_OUTPUT_BYTES) {
            await reader.cancel()
            throw new Error('Converted file is too large')
          }
          chunks.push(value)
        }
        const converted = Buffer.concat(chunks, size)
        await openPptx(converted)
        return converted
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
  }
  throw lastError
}
