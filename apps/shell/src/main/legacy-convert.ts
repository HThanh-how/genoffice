import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { dirname } from 'node:path'

/** What turns an old Office file into a new one, and where the new file goes. */
export interface ConvertBesideDeps {
  uniquePathIn(directory: string, fileName: string): string
  /** where a copy goes when the source folder cannot be written; null = give up instead */
  fallbackDir: (() => string) | null
  write(path: string, bytes: Uint8Array): Promise<void>
  linkedCopy(source: string): Promise<string | null>
  remember(source: string, converted: string, sourceHash: string): Promise<void>
  archive(source: string, converted: string, sourceHash: string): Promise<unknown>
}

export interface ConvertedBeside {
  convertedPath: string
  /** the old file was moved to the recovery folder */
  archived: boolean
  /** an earlier conversion of the same file was reused */
  reused: boolean
}

const WRITE_DENIED = new Set(['EACCES', 'EPERM', 'EROFS'])

export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** A converted OOXML file is a zip; anything else means the converter handed back junk. */
export function looksLikeOoxml(bytes: Uint8Array): boolean {
  return bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

/**
 * Convert `source` into a new file beside it, then move the old file to the recovery folder.
 * The new file is what gets opened and indexed from now on; the original stays recoverable.
 */
export async function convertBeside(
  source: string,
  targetExtension: '.xlsx' | '.docx' | '.pptx',
  produce: () => Promise<{ bytes: Uint8Array; sourceHash?: string }>,
  deps: ConvertBesideDeps,
): Promise<ConvertedBeside> {
  const linked = await deps.linkedCopy(source)
  if (linked) return { convertedPath: linked, archived: true, reused: true }
  const made = await produce()
  if (!looksLikeOoxml(made.bytes)) throw new Error('The converter returned an invalid file')
  const sourceHash = made.sourceHash ?? (await sha256OfFile(source))
  const stem = source.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const name = `${stem}${targetExtension}`
  let convertedPath = deps.uniquePathIn(dirname(source), name)
  try {
    await deps.write(convertedPath, made.bytes)
  } catch (error) {
    if (!deps.fallbackDir || !WRITE_DENIED.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw error
    }
    convertedPath = deps.uniquePathIn(deps.fallbackDir(), name)
    await deps.write(convertedPath, made.bytes)
  }
  if (dirname(convertedPath) !== dirname(source)) {
    return { convertedPath, archived: false, reused: false }
  }
  try {
    await deps.archive(source, convertedPath, sourceHash)
    return { convertedPath, archived: true, reused: false }
  } catch {
    // keep the old file where it is, but remember the pair so it is not converted again
    await deps.remember(source, convertedPath, sourceHash).catch(() => undefined)
    return { convertedPath, archived: false, reused: false }
  }
}
