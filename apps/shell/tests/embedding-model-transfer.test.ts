import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EMBEDDING_PROFILES,
  type EmbeddingProfile,
} from '../src/main/document-memory/embedding-profiles'
import {
  EmbeddingModelDownloadError,
  cachedModelFile,
  ensureModelFiles,
  modelCacheFilePath,
  type FetchLike,
  type ModelDownloadOptions,
  type ModelDownloadProgress,
} from '../src/main/document-memory/embedding/model-files'

/**
 * Range resume, mirror fall-through and untrusted-mirror handling against a real local HTTP
 * server. Bodies are small synthetic files with their own sha256 (never the real models).
 */
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const SIZE = 200_000

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** Serves `data` like a static host: Range-aware unless `ignoreRange`, optionally cutting or stalling the body. */
function blob(
  data: Buffer,
  opts: { ignoreRange?: boolean; cutAt?: number; stallAt?: number; badRangeStart?: boolean } = {},
): Handler {
  return (req, res) => {
    const match = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
    const start = match && !opts.ignoreRange ? Number(match[1]) : 0
    const body = data.subarray(start)
    if (match && !opts.ignoreRange) {
      const shown = opts.badRangeStart ? start + 1 : start
      res.writeHead(206, {
        'content-length': body.length,
        'content-range': `bytes ${shown}-${data.length - 1}/${data.length}`,
      })
    } else {
      res.writeHead(200, { 'content-length': body.length })
    }
    const limit = opts.cutAt ?? opts.stallAt
    if (limit === undefined) {
      res.end(body)
      return
    }
    res.write(body.subarray(0, limit), () => {
      // stallAt: keep the connection open and silent; cutAt: drop it once the bytes had time to arrive
      if (opts.cutAt !== undefined) setTimeout(() => res.destroy(), 50)
    })
  }
}

describe('model transfer: Range resume, mirrors and untrusted bytes', () => {
  let cache: string
  let server: Server
  let origin: string
  let profile: EmbeddingProfile
  let good: Buffer
  const requests: Array<{ path: string; range?: string; headers: IncomingMessage['headers'] }> = []
  let routes = new Map<string, Handler>()
  const file = () => profile.files[0]!
  const dest = () => modelCacheFilePath(cache, profile, file())

  /** the original host (huggingface.co) is served under /hf; mirrors are plain templates */
  const toLocal: FetchLike = (url, init) =>
    fetch(url.replace('https://huggingface.co', `${origin}/hf`), init)
  const options = (extra: ModelDownloadOptions = {}): ModelDownloadOptions => ({
    mirrors: [`${origin}/a/{path}`, `${origin}/b/{path}`],
    retryDelaysMs: [0, 0, 0],
    stallTimeoutMs: 5000,
    ...extra,
  })
  const hfPath = () => `/hf/${profile.repo}/resolve/${profile.revision}/${file().path}`

  beforeEach(async () => {
    cache = mkdtempSync(join(tmpdir(), 'genoffice-model-transfer-'))
    good = randomBytes(SIZE)
    profile = {
      ...EMBEDDING_PROFILES.base,
      files: [{ path: 'onnx/model.onnx', sha256: sha(good), bytes: SIZE }],
    }
    requests.length = 0
    routes = new Map()
    server = createServer((req, res) => {
      const path = req.url ?? ''
      requests.push({ path, range: req.headers.range, headers: req.headers })
      const handler = routes.get(path)
      if (handler) handler(req, res)
      else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(cache, { recursive: true, force: true })
  })

  it('resumes an interrupted transfer with a Range request instead of starting over', async () => {
    let first = true
    routes.set('/a/onnx/model.onnx', (req, res) => {
      if (first) {
        first = false
        blob(good, { cutAt: 90_000 })(req, res)
      } else blob(good)(req, res)
    })
    const path = await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(readFileSync(path).equals(good)).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[0]!.range).toBeUndefined()
    const resumedFrom = Number(/^bytes=(\d+)-$/.exec(requests[1]!.range ?? '')?.[1])
    expect(resumedFrom).toBeGreaterThan(0)
    expect(resumedFrom).toBeLessThanOrEqual(90_000)
    expect(existsSync(`${dest()}.part`)).toBe(false)
    expect(existsSync(`${dest()}.part.lock`)).toBe(false)
  })

  it('sends nothing but a Range header to a mirror: no cookies, tokens or user data', async () => {
    routes.set('/a/onnx/model.onnx', blob(good))
    await cachedModelFile(cache, profile, file(), toLocal, options())
    const names = Object.keys(requests[0]!.headers)
    expect(names).not.toEqual(expect.arrayContaining(['authorization']))
    expect(names).not.toEqual(expect.arrayContaining(['cookie']))
    expect(names).not.toEqual(expect.arrayContaining(['referer']))
  })

  it('continues a .part left by a killed process (even from another source)', async () => {
    mkdirSync(dirname(dest()), { recursive: true })
    writeFileSync(`${dest()}.part`, good.subarray(0, 123_456))
    routes.set('/a/onnx/model.onnx', blob(good))
    await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(requests).toHaveLength(1)
    expect(requests[0]!.range).toBe('bytes=123456-')
    expect(readFileSync(dest()).equals(good)).toBe(true)
  })

  it('restarts from zero when the server ignores Range and answers 200', async () => {
    mkdirSync(dirname(dest()), { recursive: true })
    writeFileSync(`${dest()}.part`, good.subarray(0, 50_000))
    routes.set('/a/onnx/model.onnx', blob(good, { ignoreRange: true }))
    await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(requests).toHaveLength(1)
    expect(requests[0]!.range).toBe('bytes=50000-')
    expect(readFileSync(dest()).equals(good)).toBe(true)
  })

  it('refuses a 206 whose Content-Range does not start where the part ends and uses the next source', async () => {
    mkdirSync(dirname(dest()), { recursive: true })
    writeFileSync(`${dest()}.part`, good.subarray(0, 50_000))
    routes.set('/a/onnx/model.onnx', blob(good, { badRangeStart: true }))
    routes.set('/b/onnx/model.onnx', blob(good))
    await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(requests.map((r) => r.path)).toEqual(['/a/onnx/model.onnx', '/b/onnx/model.onnx'])
    expect(readFileSync(dest()).equals(good)).toBe(true)
  })

  it('falls through 404, discards corrupted bytes of a mirror and finishes from the next source', async () => {
    const corrupt = Buffer.from(good)
    corrupt[1000] = corrupt[1000]! ^ 0xff // same length, other content
    // mirror a: 404 (no route); mirror b: corrupted; origin: good
    routes.set('/b/onnx/model.onnx', blob(corrupt))
    routes.set(hfPath(), blob(good))
    const path = await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(requests.map((r) => r.path)).toEqual([
      '/a/onnx/model.onnx',
      '/b/onnx/model.onnx',
      hfPath(),
    ])
    expect(requests[2]!.range).toBeUndefined() // the bad bytes were deleted, the origin starts clean
    expect(sha(readFileSync(path))).toBe(sha(good))
    expect(existsSync(`${dest()}.part`)).toBe(false)
  })

  it('does not retry 401/403/404 on the same source but retries 5xx and then succeeds', async () => {
    let hits = 0
    routes.set('/a/onnx/model.onnx', (req, res) => {
      hits++
      if (hits <= 2) res.writeHead(503).end()
      else blob(good)(req, res)
    })
    await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(hits).toBe(3)

    rmSync(dest())
    requests.length = 0
    routes.set('/a/onnx/model.onnx', (_req, res) => res.writeHead(403).end())
    routes.set('/b/onnx/model.onnx', blob(good))
    await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(requests.map((r) => r.path)).toEqual(['/a/onnx/model.onnx', '/b/onnx/model.onnx'])
  })

  it('gives each source a bounded number of attempts, then reports every source that was tried', async () => {
    routes.set('/a/onnx/model.onnx', (_req, res) => res.writeHead(503).end())
    routes.set('/b/onnx/model.onnx', (_req, res) => res.writeHead(404).end())
    routes.set(hfPath(), (_req, res) => res.writeHead(403).end())
    const error = await cachedModelFile(cache, profile, file(), toLocal, options()).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(error.failure).toBe('access-denied') // the canonical origin decides what the user is told
    expect(error.status).toBe(403)
    expect(requests.filter((r) => r.path === '/a/onnx/model.onnx')).toHaveLength(4) // 1 + 3 retries
    expect(requests.filter((r) => r.path === '/b/onnx/model.onnx')).toHaveLength(1)
    expect(error.message).toContain('Sources tried:')
    expect(error.message).toContain('HTTP 503')
    expect(error.message).toContain('not found')
    expect(error.message).toContain(join(cache, profile.repo, profile.revision))
  })

  it('aborts a stalled connection after the stall timeout and resumes it', async () => {
    let first = true
    routes.set('/a/onnx/model.onnx', (req, res) => {
      if (first) {
        first = false
        blob(good, { stallAt: 70_000 })(req, res)
      } else blob(good)(req, res)
    })
    const started = Date.now()
    await cachedModelFile(cache, profile, file(), toLocal, options({ stallTimeoutMs: 300 }))
    expect(Date.now() - started).toBeLessThan(4000)
    expect(requests[1]!.range).toMatch(/^bytes=[1-9]\d*-$/)
    expect(readFileSync(dest()).equals(good)).toBe(true)
  })

  it('deletes a part that was poisoned earlier and recovers on the next try', async () => {
    mkdirSync(dirname(dest()), { recursive: true })
    const poisoned = Buffer.from(good.subarray(0, 60_000))
    poisoned[5] = poisoned[5]! ^ 0xff
    writeFileSync(`${dest()}.part`, poisoned)
    routes.set(hfPath(), blob(good))
    // only the origin: the resumed bytes fail sha256, the part is removed, nothing loops
    const error = await cachedModelFile(
      cache,
      profile,
      file(),
      toLocal,
      options({ mirrors: [] }),
    ).catch((e) => e)
    expect(error.failure).toBe('checksum')
    expect(existsSync(`${dest()}.part`)).toBe(false)
    expect(requests).toHaveLength(1)
    await cachedModelFile(cache, profile, file(), toLocal, options({ mirrors: [] }))
    expect(readFileSync(dest()).equals(good)).toBe(true)
  })

  it('rejects an oversized body early and does not keep it', async () => {
    const oversized = Buffer.concat([good, Buffer.alloc(5000)])
    routes.set(hfPath(), (_req, res) => {
      res.writeHead(200).end(oversized) // no Content-Length: chunked
    })
    const error = await cachedModelFile(
      cache,
      profile,
      file(),
      toLocal,
      options({ mirrors: [] }),
    ).catch((e) => e)
    expect(error.failure).toBe('size')
    expect(existsSync(`${dest()}.part`)).toBe(false)
    expect(existsSync(dest())).toBe(false)
  })

  it('takes over a download lock left by a dead process', async () => {
    mkdirSync(dirname(dest()), { recursive: true })
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(`${dest()}.part.lock`, String(dead))
    routes.set('/a/onnx/model.onnx', blob(good))
    await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(readFileSync(dest()).equals(good)).toBe(true)
    expect(existsSync(`${dest()}.part.lock`)).toBe(false)
  })

  it('accepts a model file copied into the cache folder by hand without any request', async () => {
    mkdirSync(dirname(dest()), { recursive: true })
    writeFileSync(dest(), good)
    const path = await cachedModelFile(cache, profile, file(), toLocal, options())
    expect(path).toBe(dest())
    expect(requests).toEqual([])
    expect(statSync(dest()).size).toBe(SIZE)
  })

  it('reports whole-profile progress with the delivering host', async () => {
    const blobs = profile.files.map((f, i) => ({ f, data: randomBytes(30_000 + i * 10_000) }))
    const multi: EmbeddingProfile = {
      ...profile,
      files: [
        { path: 'tokenizer.json', sha256: sha(blobs[0]!.data), bytes: blobs[0]!.data.length },
        { path: 'tokenizer_config.json', sha256: sha(Buffer.from('{}')), bytes: 2 },
        { path: 'onnx/model.onnx', sha256: sha(good), bytes: SIZE },
      ],
    }
    routes.set('/a/tokenizer.json', blob(blobs[0]!.data))
    routes.set('/b/tokenizer_config.json', blob(Buffer.from('{}')))
    routes.set('/a/onnx/model.onnx', blob(good))
    const events: ModelDownloadProgress[] = []
    await ensureModelFiles(cache, multi, toLocal, options({ onProgress: (p) => events.push(p) }))
    const total = blobs[0]!.data.length + 2 + SIZE
    expect(events.length).toBeGreaterThan(2)
    expect(events.every((e) => e.totalBytes === total)).toBe(true)
    expect(events.map((e) => e.doneBytes)).toEqual(
      [...events.map((e) => e.doneBytes)].sort((x, y) => x - y),
    )
    expect(events.at(-1)!.doneBytes).toBe(total)
    expect(events.at(-1)!.host).toBe(new URL(origin).host)
  })
})
