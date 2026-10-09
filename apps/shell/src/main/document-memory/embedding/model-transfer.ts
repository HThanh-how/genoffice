import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EmbeddingProfileFile } from '../embedding-profiles'

/** What a download needs from fetch. `headers` is optional so minimal test doubles keep working. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  headers?: { get(name: string): string | null }
}>

export interface TransferTuning {
  /** pauses before each retry of one source; its length is the number of retries */
  retryDelaysMs: number[]
  /** no byte for this long aborts the attempt (the next one resumes) */
  stallTimeoutMs: number
}

const DEFAULT_TUNING: TransferTuning = { retryDelaysMs: [1000, 3000, 8000], stallTimeoutMs: 30_000 }

/** Defaults, overridable through the environment (tests, constrained networks). */
export function transferTuning(
  override: Partial<TransferTuning> = {},
  env: Record<string, string | undefined> = process.env,
): TransferTuning {
  const delays = env.GENOFFICE_MODEL_RETRY_DELAYS_MS
  const stall = Number(env.GENOFFICE_MODEL_STALL_TIMEOUT_MS)
  return {
    retryDelaysMs:
      override.retryDelaysMs ??
      (delays === undefined
        ? DEFAULT_TUNING.retryDelaysMs
        : delays
            .split(',')
            .filter((part) => part.trim() !== '')
            .map(Number)
            .filter((n) => Number.isFinite(n) && n >= 0)),
    stallTimeoutMs: override.stallTimeoutMs ?? (stall > 0 ? stall : DEFAULT_TUNING.stallTimeoutMs),
  }
}

/** Why one source gave up. `status` is set for HTTP answers. */
export type SourceFailure =
  | { failure: 'access-denied' | 'not-found' | 'http'; status?: number }
  | { failure: 'network' | 'size' }

type Attempt =
  | { kind: 'complete' }
  | { kind: 'status'; status: number }
  /** transport error, stall or other transient trouble: worth a retry */
  | { kind: 'transient' }
  /** the server answered something this download cannot use (wrong range, wrong length) */
  | { kind: 'unusable' }
  /** more bytes than the manifest allows; the part is garbage */
  | { kind: 'oversize' }

/** `bytes a-b/total` of a 206 answer */
function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value ?? '')
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  }
}

async function partSize(part: string): Promise<number> {
  return stat(part).then(
    (s) => s.size,
    () => 0,
  )
}

/** One request for the rest of `part`: Range when bytes are already there, a fresh file otherwise. */
async function attempt(
  fetchImpl: FetchLike,
  url: string,
  part: string,
  file: EmbeddingProfileFile,
  stallTimeoutMs: number,
  onBytes: (bytes: number) => void,
): Promise<Attempt> {
  await mkdir(dirname(part), { recursive: true })
  let have = await partSize(part)
  if (file.bytes !== undefined && have > file.bytes) {
    await rm(part, { force: true })
    have = 0
  }
  onBytes(have)
  if (file.bytes !== undefined && have === file.bytes) return { kind: 'complete' }

  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), stallTimeoutMs)
  }
  // Only a Range header is sent: no cookies, tokens or user data ever go to a mirror.
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
  if (have > 0) headers.Range = `bytes=${have}-`

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    arm()
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    if (response.status === 416 && have > 0) {
      await rm(part, { force: true }) // the part is not a prefix of this file
      return { kind: 'transient' }
    }
    if (!response.ok || !response.body) return { kind: 'status', status: response.status }

    let resumed = false
    if (have > 0 && response.status === 206) {
      const range = parseContentRange(response.headers?.get('content-range') ?? null)
      const exactEnd = range && (range.total === null || range.end === range.total - 1)
      const totalOk =
        range && (file.bytes === undefined || range.total === null || range.total === file.bytes)
      if (!range || range.start !== have || !exactEnd || !totalOk) return { kind: 'unusable' }
      resumed = true
    } else if (response.status !== 200) {
      return { kind: 'unusable' }
    }
    // A 200 to a Range request means the server ignored it: the file restarts from zero.
    const length = Number(response.headers?.get('content-length') ?? NaN)
    if (
      file.bytes !== undefined &&
      Number.isFinite(length) &&
      length !== file.bytes - (resumed ? have : 0)
    ) {
      return { kind: 'unusable' }
    }

    let written = resumed ? have : 0
    handle = await open(part, resumed ? 'a' : 'w')
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      written += value.length
      if (file.bytes !== undefined && written > file.bytes) {
        controller.abort()
        await handle.close()
        handle = undefined
        await rm(part, { force: true })
        return { kind: 'oversize' }
      }
      await handle.write(value)
      onBytes(written)
    }
    await handle.sync()
    return { kind: 'complete' }
  } catch {
    return { kind: 'transient' } // the bytes written so far stay for the next attempt
  } finally {
    clearTimeout(timer)
    controller.abort() // really cancels a connection that is still open
    await handle?.close().catch(() => {})
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetches the file from one source into `part`, resuming with Range after every interruption.
 * Network errors, 5xx answers and stalls are retried with the configured pauses; 401/403/404
 * and unusable answers end the source at once. On success `part` holds the whole body
 * (not yet verified) and the result is null.
 */
export async function transferFromSource(
  fetchImpl: FetchLike,
  url: string,
  part: string,
  file: EmbeddingProfileFile,
  tuning: TransferTuning,
  onBytes: (bytes: number) => void,
): Promise<SourceFailure | null> {
  for (let tried = 0; ; tried++) {
    const outcome = await attempt(fetchImpl, url, part, file, tuning.stallTimeoutMs, onBytes)
    switch (outcome.kind) {
      case 'complete':
        return null
      case 'oversize':
        return { failure: 'size' }
      case 'unusable':
        return { failure: 'http' }
      case 'status':
        if (outcome.status === 401 || outcome.status === 403)
          return { failure: 'access-denied', status: outcome.status }
        if (outcome.status === 404) return { failure: 'not-found', status: outcome.status }
        if (outcome.status < 500 && outcome.status !== 408 && outcome.status !== 429)
          return { failure: 'http', status: outcome.status }
        if (tried >= tuning.retryDelaysMs.length) return { failure: 'http', status: outcome.status }
        break
      case 'transient':
        if (tried >= tuning.retryDelaysMs.length) return { failure: 'network' }
        break
    }
    await sleep(tuning.retryDelaysMs[tried]!)
  }
}
