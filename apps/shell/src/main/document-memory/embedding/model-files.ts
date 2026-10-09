import { createReadStream, statSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { EmbeddingProfile, EmbeddingProfileFile } from '../embedding-profiles'

export type EmbeddingDownloadFailure =
  | 'access-denied'
  | 'not-found'
  | 'http'
  | 'network'
  | 'checksum'
  | 'size'

/**
 * A model file could not be fetched or did not match its pinned checksum. `message` is safe
 * and actionable enough to show to the user as-is; the indexer reports it instead of the
 * generic "model unavailable" text and keeps text search running.
 */
export class EmbeddingModelDownloadError extends Error {
  constructor(
    message: string,
    readonly failure: EmbeddingDownloadFailure,
    readonly profileId: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EmbeddingModelDownloadError'
  }
}

export function modelFileUrl(profile: EmbeddingProfile, file: EmbeddingProfileFile): string {
  return `https://huggingface.co/${profile.repo}/resolve/${profile.revision}/${file.path}`
}

export function modelCacheFilePath(
  cache: string,
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
): string {
  return join(cache, profile.repo, profile.revision, file.path)
}

/** True when every file of the manifest is already on disk with its pinned size (no hashing: a cheap status check). */
export function modelFilesCached(cache: string, profile: EmbeddingProfile): boolean {
  return profile.files.every((file) => {
    try {
      const size = statSync(modelCacheFilePath(cache, profile, file)).size
      return file.bytes === undefined || size === file.bytes
    } catch {
      return false
    }
  })
}

function failureMessage(
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
  cache: string,
  failure: EmbeddingDownloadFailure,
  status?: number,
): string {
  const where = `${profile.repo}@${profile.revision.slice(0, 10)}`
  const manual = `copy the model files into ${join(cache, profile.repo, profile.revision)} by hand`
  switch (failure) {
    case 'access-denied':
      return (
        `The search model ${where} could not be downloaded: the host answered HTTP ${status} ` +
        `(access denied) for ${file.path}. The model repository is private, gated or has been removed. ` +
        `Choose another search model in Settings (the Base, Balanced, Mid and Plus models use public repositories) ` +
        `or ${manual}. Text search keeps working.`
      )
    case 'not-found':
      return (
        `The search model ${where} could not be downloaded: ${file.path} was not found (HTTP ${status}). ` +
        `Choose another search model in Settings or ${manual}. Text search keeps working.`
      )
    case 'network':
      return (
        `The search model ${where} could not be downloaded: the model host is unreachable. ` +
        `Check the internet connection and try again, or ${manual}. Text search keeps working.`
      )
    case 'checksum':
      return (
        `The downloaded search model file ${file.path} (${where}) failed its SHA-256 check and was deleted. ` +
        `Try again later or choose another search model in Settings. Text search keeps working.`
      )
    case 'size':
      return (
        `The downloaded search model file ${file.path} (${where}) has an unexpected size and was deleted. ` +
        `Try again later or choose another search model in Settings. Text search keeps working.`
      )
    default:
      return (
        `The search model ${where} could not be downloaded: the host answered HTTP ${status} for ${file.path}. ` +
        `Try again later or choose another search model in Settings. Text search keeps working.`
      )
  }
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * A cached file counts as verified once its SHA-256 matched; the result is remembered next to it
 * (with the size) so a 2 GB model is hashed once, not on every start.
 */
async function verified(path: string, file: EmbeddingProfileFile): Promise<boolean> {
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(path)
  } catch {
    return false
  }
  if (file.bytes !== undefined && fileStat.size !== file.bytes) return false

  if (!file.sha256) return true
  const marker = `${path}.verified`
  try {
    const recorded = await readFile(marker, 'utf8')
    if (recorded === `${file.sha256}:${fileStat.size}`) return true
  } catch {
    /* not verified yet */
  }

  try {
    const calculated = await sha256OfFile(path)
    if (calculated !== file.sha256) return false
    await writeFile(marker, `${file.sha256}:${fileStat.size}`)
    return true
  } catch {
    return false
  }
}

export type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'body'>>

/** Partial downloads left behind by a process that was killed mid-transfer would otherwise sit on disk forever. */
async function removeStaleParts(destination: string): Promise<void> {
  const prefix = `${basename(destination)}.part-`
  try {
    for (const name of await readdir(dirname(destination))) {
      if (name.startsWith(prefix)) await rm(join(dirname(destination), name), { force: true })
    }
  } catch {
    // best effort: a leftover part file only costs disk space
  }
}

async function downloadFile(
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
  cache: string,
  destination: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const url = modelFileUrl(profile, file)
  await mkdir(dirname(destination), { recursive: true })
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(url)
  } catch {
    throw new EmbeddingModelDownloadError(
      failureMessage(profile, file, cache, 'network'),
      'network',
      profile.id,
      url,
    )
  }
  if (!response.ok || !response.body) {
    const status = response.status
    const failure: EmbeddingDownloadFailure =
      status === 401 || status === 403 ? 'access-denied' : status === 404 ? 'not-found' : 'http'
    throw new EmbeddingModelDownloadError(
      failureMessage(profile, file, cache, failure, status),
      failure,
      profile.id,
      url,
      status,
    )
  }
  const reader = response.body.getReader()
  await removeStaleParts(destination)
  const part = `${destination}.part-${Date.now()}`
  const handle = await open(part, 'w')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await handle.write(value)
    }
    await handle.sync()
    await handle.close()
    await rename(part, destination)
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(part, { force: true }).catch(() => {})
    throw new EmbeddingModelDownloadError(
      failureMessage(profile, file, cache, 'network'),
      'network',
      profile.id,
      url,
    )
  }
}

/** Returns the local path of a verified model file, downloading it (pinned revision) when needed. */
export async function cachedModelFile(
  cache: string,
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
  fetchImpl: FetchLike = (url) => fetch(url),
): Promise<string> {
  const path = modelCacheFilePath(cache, profile, file)
  if (await verified(path, file)) return path
  await downloadFile(profile, file, cache, path, fetchImpl)
  if (!(await verified(path, file))) {
    const sizeMismatch =
      file.bytes !== undefined &&
      (await stat(path).then((s) => s.size !== file.bytes).catch(() => false))
    await rm(path, { force: true }).catch(() => {})
    const failure: EmbeddingDownloadFailure = sizeMismatch ? 'size' : 'checksum'
    throw new EmbeddingModelDownloadError(
      failureMessage(profile, file, cache, failure),
      failure,
      profile.id,
      modelFileUrl(profile, file),
    )
  }
  return path
}

/** Every file of the manifest, verified and local, keyed by manifest path. */
export async function ensureModelFiles(
  cache: string,
  profile: EmbeddingProfile,
  fetchImpl?: FetchLike,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
  for (const file of profile.files) paths.set(file.path, await cachedModelFile(cache, profile, file, fetchImpl))
  return paths
}
