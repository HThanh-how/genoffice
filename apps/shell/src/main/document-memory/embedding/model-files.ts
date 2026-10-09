import { createReadStream, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { EmbeddingProfile, EmbeddingProfileFile } from '../embedding-profiles'
import { acquireDownloadLock } from './download-lock'
import { modelFileUrl, modelSources } from './model-mirrors'
import {
  transferFromSource,
  transferTuning,
  type FetchLike,
  type TransferTuning,
} from './model-transfer'

export { modelFileUrl } from './model-mirrors'
export type { FetchLike } from './model-transfer'

export type EmbeddingDownloadFailure =
  'access-denied' | 'not-found' | 'http' | 'network' | 'checksum' | 'size'

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

/** One source that was tried, for the failure text. Only the host name is ever shown. */
interface TriedSource {
  host: string
  url: string
  failure: EmbeddingDownloadFailure
  status?: number
}

function describeTried(source: TriedSource): string {
  const what: Record<EmbeddingDownloadFailure, string> = {
    'access-denied': `HTTP ${source.status} access denied`,
    'not-found': `not found (HTTP ${source.status})`,
    http: source.status === undefined ? 'unusable answer' : `HTTP ${source.status}`,
    network: 'unreachable or too slow',
    checksum: 'wrong content',
    size: 'wrong size',
  }
  return `${source.host} (${what[source.failure]})`
}

function failureMessage(
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
  cache: string,
  failure: EmbeddingDownloadFailure,
  status: number | undefined,
  tried: TriedSource[],
): string {
  const where = `${profile.repo}@${profile.revision.slice(0, 10)}`
  const folder = join(cache, profile.repo, profile.revision)
  const manual = `copy the model files into ${folder} by hand`
  const trail = ` Cache folder: ${folder}. Sources tried: ${tried.map(describeTried).join(', ')}.`
  switch (failure) {
    case 'access-denied':
      return (
        `The search model ${where} could not be downloaded: the host answered HTTP ${status} ` +
        `(access denied) for ${file.path}. The model repository is private, gated or has been removed. ` +
        `Choose another search model in Settings (the Base, Balanced, Mid and Plus models use public repositories) ` +
        `or ${manual}. Text search keeps working.${trail}`
      )
    case 'not-found':
      return (
        `The search model ${where} could not be downloaded: ${file.path} was not found (HTTP ${status}). ` +
        `Choose another search model in Settings or ${manual}. Text search keeps working.${trail}`
      )
    case 'network':
      return (
        `The search model ${where} could not be downloaded: the model host is unreachable or too slow. ` +
        `Check the internet connection and try again (the download resumes where it stopped), or ${manual}. ` +
        `Text search keeps working.${trail}`
      )
    case 'checksum':
      return (
        `The downloaded search model file ${file.path} (${where}) failed its SHA-256 check and was deleted. ` +
        `Try again later, choose another search model in Settings or ${manual}. Text search keeps working.${trail}`
      )
    case 'size':
      return (
        `The downloaded search model file ${file.path} (${where}) has an unexpected size and was deleted. ` +
        `Try again later, choose another search model in Settings or ${manual}. Text search keeps working.${trail}`
      )
    default:
      return (
        `The search model ${where} could not be downloaded: the host answered ${status === undefined ? 'with an unusable response' : `HTTP ${status}`} for ${file.path}. ` +
        `Try again later, choose another search model in Settings or ${manual}. Text search keeps working.${trail}`
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

/** Progress of one download, in bytes; `host` is the source that is delivering right now. */
export interface ModelDownloadProgress {
  doneBytes: number
  /** 0 when the manifest does not pin sizes */
  totalBytes: number
  host: string
  file: string
}

export interface ModelDownloadOptions extends Partial<TransferTuning> {
  /** cachedModelFile reports the one file, ensureModelFiles the whole profile */
  onProgress?: (progress: ModelDownloadProgress) => void
  /** URL templates replacing the built-in mirrors and GENOFFICE_MODEL_MIRRORS (see model-mirrors.ts) */
  mirrors?: readonly string[]
}

/**
 * Partial downloads from the old naming scheme (`.part-<timestamp>`) that a killed process left
 * behind would otherwise sit on disk forever. The current `<file>.part` is kept: it is resumed.
 */
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

/** Calls `report` at most every 250 ms, but always for the first and the last byte count. */
function throttled(
  report: ((progress: ModelDownloadProgress) => void) | undefined,
  file: EmbeddingProfileFile,
): (bytes: number, host: string) => void {
  let last = 0
  return (bytes, host) => {
    if (!report) return
    const now = Date.now()
    if (last !== 0 && now - last < 250 && bytes !== file.bytes) return
    last = now
    report({ doneBytes: bytes, totalBytes: file.bytes ?? 0, host, file: file.path })
  }
}

/**
 * Fills `destination` from the ordered sources (mirrors first, the original host last). The bytes
 * of every source are untrusted: a source whose bytes fail the size or sha256 check is discarded,
 * its file deleted, and the next source starts from zero. A source that merely dies keeps the
 * `.part` file, so the next attempt (same source or the next one) resumes with a Range request.
 */
async function downloadFile(
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
  cache: string,
  destination: string,
  fetchImpl: FetchLike,
  options: ModelDownloadOptions,
): Promise<void> {
  const part = `${destination}.part`
  await mkdir(dirname(destination), { recursive: true })
  await removeStaleParts(destination)
  const release = await acquireDownloadLock(`${part}.lock`)
  if (!release) {
    throw new EmbeddingModelDownloadError(
      `The search model ${profile.repo}@${profile.revision.slice(0, 10)} is already being downloaded by another GenOffice process. Try again in a minute.`,
      'network',
      profile.id,
      modelFileUrl(profile, file),
    )
  }
  try {
    if (await verified(destination, file)) return // finished by the process that held the lock
    const tuning = transferTuning(options)
    const report = throttled(options.onProgress, file)
    const tried: TriedSource[] = []
    for (const source of modelSources(profile, file, options.mirrors)) {
      const failure = await transferFromSource(fetchImpl, source.url, part, file, tuning, (bytes) =>
        report(bytes, source.host),
      )
      if (!failure) {
        await rename(part, destination)
        if (await verified(destination, file)) return
        const sizeMismatch =
          file.bytes !== undefined &&
          (await stat(destination)
            .then((s) => s.size !== file.bytes)
            .catch(() => false))
        await rm(destination, { force: true })
        tried.push({
          host: source.host,
          url: source.url,
          failure: sizeMismatch ? 'size' : 'checksum',
        })
        continue
      }
      if (failure.failure === 'size') await rm(part, { force: true })
      tried.push({ host: source.host, url: source.url, ...failure })
    }
    const last = tried.at(-1)!
    throw new EmbeddingModelDownloadError(
      failureMessage(profile, file, cache, last.failure, last.status, tried),
      last.failure,
      profile.id,
      last.url,
      last.status,
    )
  } finally {
    await release()
  }
}

/** Returns the local path of a verified model file, downloading it (pinned revision) when needed. */
export async function cachedModelFile(
  cache: string,
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  options: ModelDownloadOptions = {},
): Promise<string> {
  const path = modelCacheFilePath(cache, profile, file)
  if (await verified(path, file)) return path
  await downloadFile(profile, file, cache, path, fetchImpl, options)
  return path
}

/** Every file of the manifest, verified and local, keyed by manifest path. */
export async function ensureModelFiles(
  cache: string,
  profile: EmbeddingProfile,
  fetchImpl?: FetchLike,
  options: ModelDownloadOptions = {},
): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
  const totalBytes = profile.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0)
  let finishedBytes = 0
  for (const file of profile.files) {
    const offset = finishedBytes
    const path = await cachedModelFile(cache, profile, file, fetchImpl, {
      ...options,
      onProgress:
        options.onProgress &&
        ((p) => options.onProgress!({ ...p, doneBytes: offset + p.doneBytes, totalBytes })),
    })
    paths.set(file.path, path)
    finishedBytes +=
      file.bytes ??
      (await stat(path).then(
        (s) => s.size,
        () => 0,
      ))
  }
  return paths
}
