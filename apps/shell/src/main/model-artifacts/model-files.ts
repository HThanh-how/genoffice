import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { verifyModel } from '@genoffice/local-llm'
import { acquireDownloadLock } from './download-lock'
import { transferFromSource, transferTuning, type FetchLike } from './model-transfer'

export interface PinnedArtifact {
  path: string
  bytes: number
  sha256: string
}

/**
 * The lock covers verification, transfer, promotion and deletion of invalid bytes.
 * Resolves true when this call completed a download, false when a valid file was already there.
 */
export async function ensureArtifact(
  destination: string,
  file: PinnedArtifact,
  url: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  fetchImpl: FetchLike = fetch,
  /** every byte is here and the checksum is being computed */
  onVerifying: () => void = () => {},
): Promise<boolean> {
  await mkdir(dirname(destination), { recursive: true })
  const release = await acquireDownloadLock(`${destination}.part.lock`, 15_000, signal)
  if (!release)
    throw new Error('Model download is owned by another GenOffice process. Retry later.')
  try {
    signal.throwIfAborted()
    if (await stat(destination).catch(() => null)) {
      try {
        onVerifying()
        await verifyModel(destination, signal, file)
        return false
      } catch (error) {
        signal.throwIfAborted()
        await rm(destination, { force: true })
        throw error
      }
    }
    const partial = await stat(`${destination}.part`).then(
      (s) => s.size,
      () => 0,
    )
    const disk = await statfs(dirname(destination))
    if (disk.bavail * disk.bsize < file.bytes - partial + 128 * 1024 ** 2)
      throw new Error('Not enough disk space for local model (including 128 MiB reserve)')
    const failure = await transferFromSource(
      fetchImpl,
      url,
      `${destination}.part`,
      file,
      { ...transferTuning(), signal },
      onBytes,
    )
    if (failure) {
      if (failure.failure === 'size') await rm(`${destination}.part`, { force: true })
      throw new Error(`Local model download failed: ${failure.failure}`)
    }
    try {
      onVerifying()
      await verifyModel(`${destination}.part`, signal, file)
    } catch (error) {
      if (!signal.aborted) await rm(`${destination}.part`, { force: true })
      throw error
    }
    await rename(`${destination}.part`, destination)
    return true
  } finally {
    await release()
  }
}

/** A cancelling/waiting process never removes another writer's partial file. */
export async function deleteArtifact(destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const release = await acquireDownloadLock(`${destination}.part.lock`, 0)
  if (!release) throw new Error('Cannot delete a model being downloaded by another process')
  try {
    await rm(destination, { force: true })
    await rm(`${destination}.part`, { force: true })
    await rm(`${destination}.verified`, { force: true })
  } finally {
    await release()
  }
}
