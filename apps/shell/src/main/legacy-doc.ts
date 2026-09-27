import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildBlankDocx, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { docToText } from '@genoffice/file-parse'

const execFileAsync = promisify(execFile)
const MAX_DOC_BYTES = 50 * 1024 * 1024

export type LegacyDocConversion = { bytes: Uint8Array; fidelity: 'formatted' | 'text' }

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
export async function convertLegacyDoc(filePath: string): Promise<LegacyDocConversion> {
  if (!/\.doc$/i.test(filePath)) throw new Error('Expected a .doc file')
  const source = await readFile(filePath)
  if (source.byteLength === 0 || source.byteLength > MAX_DOC_BYTES) {
    throw new Error('The .doc file is empty or exceeds the 50 MB import limit')
  }
  const formatted = await convertWithMacTextutil(filePath)
  if (formatted) return { bytes: formatted, fidelity: 'formatted' }

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
  return { bytes, fidelity: 'text' }
}
