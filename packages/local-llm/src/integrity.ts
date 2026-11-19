import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { LFM_MANIFEST } from './manifest'
import { LocalLlmError } from './protocol'

/** Deliberately never consults .verified, mtime, environment, or a persisted hash cache. */
export async function verifyModel(
  path: string,
  signal?: AbortSignal,
  file: { bytes: number; sha256: string } = LFM_MANIFEST.files[0],
): Promise<void> {
  signal?.throwIfAborted()
  const info = await stat(path).catch(() => {
    throw new LocalLlmError(
      'MODEL_MISSING',
      'Local model is missing. Download it in Settings → AI Model.',
    )
  })
  if (!info.isFile() || info.size !== file.bytes)
    throw new LocalLlmError('MODEL_SIZE', 'Local model has an unexpected byte count')
  const hash = createHash('sha256')
  // Fewer asynchronous reads matter in Electron utility processes on Windows.
  for await (const chunk of createReadStream(path, { signal, highWaterMark: 4 * 1024 * 1024 }))
    hash.update(chunk)
  if (hash.digest('hex') !== file.sha256)
    throw new LocalLlmError('MODEL_CHECKSUM', 'Local model failed SHA-256 verification')
}
