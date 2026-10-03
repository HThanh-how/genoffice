import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildBlankDocx, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { docToText } from '@genoffice/file-parse'

const execFileAsync = promisify(execFile)
const MAX_DOC_BYTES = 50 * 1024 * 1024
const MAX_CONVERTED_BYTES = 50 * 1024 * 1024

export type LegacyDocConversion = {
  bytes: Uint8Array
  fidelity: 'formatted' | 'text'
  sourceHash: string
}

export const DEFAULT_LEGACY_DOC_SERVICE = 'https://d2x.clouds.io.vn'

/** Answers worth asking again: the service was busy, restarting or slow, not "this file is bad". */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const SERVICE_ATTEMPTS = 4
const ATTEMPT_TIMEOUT_MS = 45_000
const RETRY_PAUSE_MS = 500

/**
 * A document is sent online only when the caller supplies an endpoint. A failed try (a dropped
 * connection, a timeout, a busy service) is repeated a few times with growing pauses, so one bad
 * moment does not turn a formatted document into a text-only copy.
 */
export async function convertWithService(
  source: Uint8Array,
  endpoint: string,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Uint8Array | null> {
  let url: URL
  try {
    url = new URL('/v1/convert/docx', endpoint)
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
        headers: { 'Content-Type': 'application/msword' },
        body: Buffer.from(source),
        // each try has its own time: a slow first one must not use up the others'
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      })
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
      await parseDocx(bytes)
      return bytes
    } catch {
      // a dropped connection, a timeout or a reply that is not a document: try again
    }
  }
  return null
}

/** macOS ships textutil, which can read .doc and write .docx without another app. */
async function convertWithMacTextutil(filePath: string): Promise<Uint8Array | null> {
  if (process.platform !== 'darwin') return null
  const temporary = await mkdtemp(join(tmpdir(), 'genoffice-doc-'))
  try {
    const output = join(temporary, 'converted.docx')
    await execFileAsync('/usr/bin/textutil', ['-convert', 'docx', '-output', output, filePath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    const bytes = await readFile(output)
    // Conversion is only accepted if the editor can parse it. Otherwise use text recovery.
    await parseDocx(bytes)
    return bytes
  } catch {
    return null
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Open a legacy Word file as new .docx bytes; never writes to the .doc source. */
export async function convertLegacyDoc(
  filePath: string,
  serviceEndpoint?: string,
): Promise<LegacyDocConversion> {
  if (!/\.doc$/i.test(filePath)) throw new Error('Expected a .doc file')
  const source = await readFile(filePath)
  if (source.byteLength === 0 || source.byteLength > MAX_DOC_BYTES) {
    throw new Error('The .doc file is empty or exceeds the 50 MB import limit')
  }
  const sourceHash = createHash('sha256').update(source).digest('hex')
  if (serviceEndpoint) {
    const remote = await convertWithService(source, serviceEndpoint)
    if (remote) return { bytes: remote, fidelity: 'formatted', sourceHash }
  }
  const formatted = await convertWithMacTextutil(filePath)
  if (formatted) return { bytes: formatted, fidelity: 'formatted', sourceHash }

  const text = await docToText(source)
  if (!text.trim()) throw new Error('No readable text found in the .doc file')
  const blank = await parseDocx(await buildBlankDocx())
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n')
  const bytes = await saveDocx(
    blank,
    paragraphs.map((line) => ({
      kind: 'generated' as const,
      block: { type: 'paragraph' as const, runs: [{ text: line }] },
    })),
  )
  return { bytes, fidelity: 'text', sourceHash }
}
