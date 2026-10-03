import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildBlankDocx, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { docToText } from '@genoffice/file-parse'
import {
  DEFAULT_CONVERSION_SERVICE,
  DOCX_ROUTE,
  ServiceRateLimitedError,
  convertThroughService,
} from './legacy-service'

const execFileAsync = promisify(execFile)
const MAX_DOC_BYTES = 50 * 1024 * 1024

export type LegacyDocConversion = {
  bytes: Uint8Array
  fidelity: 'formatted' | 'text'
  sourceHash: string
}

export const DEFAULT_LEGACY_DOC_SERVICE = DEFAULT_CONVERSION_SERVICE

/**
 * A document is sent online only when the caller supplies an endpoint. A failed try is repeated
 * (see `convertThroughService`), so one bad moment does not turn a formatted document into a
 * text-only copy. `strict` lets the service's hourly limit reach the caller instead of being
 * treated as "could not convert".
 */
export async function convertWithService(
  source: Uint8Array,
  endpoint: string,
  pause?: (ms: number) => Promise<void>,
  options: { strict?: boolean } = {},
): Promise<Uint8Array | null> {
  try {
    return await convertThroughService(
      source,
      endpoint,
      DOCX_ROUTE,
      async (bytes) => void (await parseDocx(bytes)),
      pause,
    )
  } catch (error) {
    if (error instanceof ServiceRateLimitedError && !options.strict) return null
    throw error
  }
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
  options: { strict?: boolean } = {},
): Promise<LegacyDocConversion> {
  if (!/\.doc$/i.test(filePath)) throw new Error('Expected a .doc file')
  const source = await readFile(filePath)
  if (source.byteLength === 0 || source.byteLength > MAX_DOC_BYTES) {
    throw new Error('The .doc file is empty or exceeds the 50 MB import limit')
  }
  const sourceHash = createHash('sha256').update(source).digest('hex')
  if (serviceEndpoint) {
    const remote = await convertWithService(source, serviceEndpoint, undefined, options)
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
