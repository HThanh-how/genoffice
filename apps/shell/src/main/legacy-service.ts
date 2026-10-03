/**
 * The conversion service (d2x: LibreOffice behind a small HTTP gateway) turns an old Office file
 * into the new format with its formatting intact. Every conversion of a .doc, .xls or .ppt goes
 * through it; nothing is converted on this computer.
 */
export const DEFAULT_CONVERSION_SERVICE = 'https://d2x.clouds.io.vn'

export interface ServiceRoute {
  /** the gateway's path for this conversion */
  path: string
  /** the Content-Type the gateway insists on for the old format */
  contentType: string
}

export const DOCX_ROUTE: ServiceRoute = {
  path: '/v1/convert/docx',
  contentType: 'application/msword',
}
export const XLSX_ROUTE: ServiceRoute = {
  path: '/v1/convert/xlsx',
  contentType: 'application/vnd.ms-excel',
}

/** The service allows only so many conversions an hour; asking again soon cannot help. */
export class ServiceRateLimitedError extends Error {
  constructor() {
    super('The conversion service has reached its hourly limit')
    this.name = 'ServiceRateLimitedError'
  }
}

/** Answers worth asking again: the service was busy, restarting or slow, not "this file is bad". */
const RETRYABLE_STATUSES = new Set([408, 425, 500, 502, 503, 504])
const SERVICE_ATTEMPTS = 4
const ATTEMPT_TIMEOUT_MS = 45_000
const RETRY_PAUSE_MS = 500
const MAX_CONVERTED_BYTES = 50 * 1024 * 1024

const realPause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Send `source` to the service and return the converted bytes, or null when this file cannot be
 * converted. A failed try (a dropped connection, a timeout, a busy service) is repeated a few
 * times with growing pauses, so one bad moment does not turn into a failed conversion. The hourly
 * limit is not repeated: it throws, so a caller that has many files can wait it out.
 * `accept` rejects a reply that is not a document the editor can open.
 */
export async function convertThroughService(
  source: Uint8Array,
  endpoint: string,
  route: ServiceRoute,
  accept: (bytes: Uint8Array) => Promise<void>,
  pause: (ms: number) => Promise<void> = realPause,
): Promise<Uint8Array | null> {
  let url: URL
  try {
    url = new URL(route.path, endpoint)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
      return null
    }
  } catch {
    return null
  }
  for (let attempt = 0; attempt < SERVICE_ATTEMPTS; attempt++) {
    if (attempt > 0) await pause(RETRY_PAUSE_MS * attempt * attempt)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': route.contentType },
        body: Buffer.from(source),
        // each try has its own time: a slow first one must not use up the others'
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      })
      if (response.status === 429) throw new ServiceRateLimitedError()
      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status)) continue
        return null
      }
      const length = Number(response.headers.get('content-length'))
      if (Number.isFinite(length) && length > MAX_CONVERTED_BYTES) return null
      if (!response.body) continue
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_CONVERTED_BYTES) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
      const bytes = Buffer.concat(chunks, received)
      await accept(bytes)
      return bytes
    } catch (error) {
      if (error instanceof ServiceRateLimitedError) throw error
      // a dropped connection, a timeout or a reply that is not a document: try again
    }
  }
  return null
}
