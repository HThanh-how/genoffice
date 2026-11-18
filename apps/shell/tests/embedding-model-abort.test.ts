import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EmbeddingModelDownloadError,
  cachedModelFile,
  modelCacheFilePath,
  verifyModelFile,
  type FetchLike,
  type ModelArtifactManifest,
  type ModelDownloadOptions,
} from '../src/main/document-memory/embedding/model-files'

/**
 * Downloader extensions used by the local chat model: a caller's AbortSignal, a full disk, and
 * the failure-message label. A plain manifest (not an embedding profile) is used on purpose.
 */

// ENOSPC cannot be produced on demand, so writes to the .part fail when `writeFault.code` is set
const writeFault = vi.hoisted(() => ({ code: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const code = writeFault.code
      if (!code) return handle
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'write') {
            return async () => {
              const error = new Error('no space left on device') as NodeJS.ErrnoException
              error.code = code
              throw error
            }
          }
          const value = Reflect.get(target, prop, target) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      })
    },
  }
})

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const SIZE = 200_000
type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** Range-aware static file; `stallAt` sends that many bytes and then keeps the connection silent. */
function blob(data: Buffer, opts: { stallAt?: number } = {}): Handler {
  return (req, res) => {
    const match = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
    const start = match ? Number(match[1]) : 0
    const body = data.subarray(start)
    if (match) {
      res.writeHead(206, {
        'content-length': body.length,
        'content-range': `bytes ${start}-${data.length - 1}/${data.length}`,
      })
    } else {
      res.writeHead(200, { 'content-length': body.length })
    }
    if (opts.stallAt === undefined) res.end(body)
    else res.write(body.subarray(0, opts.stallAt))
  }
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('model downloader: cancel, disk full, label', () => {
  let cache: string
  let server: Server
  let origin: string
  let good: Buffer
  let manifest: ModelArtifactManifest
  const requests: Array<{ path: string; range?: string }> = []
  let routes = new Map<string, Handler>()
  const file = () => manifest.files[0]!
  const dest = () => modelCacheFilePath(cache, manifest, file())
  const toLocal: FetchLike = (url, init) =>
    fetch(url.replace('https://huggingface.co', `${origin}/hf`), init)
  const hfPath = () => `/hf/${manifest.repo}/resolve/${manifest.revision}/${file().path}`
  const options = (extra: ModelDownloadOptions = {}): ModelDownloadOptions => ({
    retryDelaysMs: [0, 0],
    stallTimeoutMs: 5000,
    ...extra,
  })

  beforeEach(async () => {
    cache = mkdtempSync(join(tmpdir(), 'genoffice-model-abort-'))
    good = randomBytes(SIZE)
    manifest = {
      id: 'test-model',
      repo: 'test-org/test-model',
      revision: 'a'.repeat(40),
      files: [{ path: 'model.gguf', sha256: sha(good), bytes: SIZE }],
      mirrorable: false,
    }
    requests.length = 0
    routes = new Map()
    writeFault.code = null
    server = createServer((req, res) => {
      const path = req.url ?? ''
      requests.push({ path, range: req.headers.range })
      const handler = routes.get(path)
      if (handler) handler(req, res)
      else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    writeFault.code = null
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(cache, { recursive: true, force: true })
  })

  it('stops on abort, keeps the .part, and the next call resumes it with a Range request', async () => {
    routes.set(hfPath(), blob(good, { stallAt: 60_000 }))
    const controller = new AbortController()
    const pending = cachedModelFile(cache, manifest, file(), toLocal, options({ signal: controller.signal }))
    await until(() => existsSync(`${dest()}.part`) && statSync(`${dest()}.part`).size > 0)
    controller.abort()
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect((error as EmbeddingModelDownloadError).failure).toBe('aborted')
    const kept = statSync(`${dest()}.part`).size
    expect(kept).toBeGreaterThan(0)
    expect(existsSync(`${dest()}.part.lock`)).toBe(false)

    routes.set(hfPath(), blob(good))
    const path = await cachedModelFile(cache, manifest, file(), toLocal, options())
    expect(readFileSync(path).equals(good)).toBe(true)
    expect(requests.at(-1)!.range).toBe(`bytes=${kept}-`)
  })

  it('does not try another source after a cancel', async () => {
    const mirrored = { ...manifest, mirrorable: true }
    routes.set('/a/model.gguf', blob(good, { stallAt: 50_000 }))
    routes.set('/b/model.gguf', blob(good))
    const controller = new AbortController()
    const pending = cachedModelFile(
      cache,
      mirrored,
      file(),
      toLocal,
      options({ signal: controller.signal, mirrors: [`${origin}/a/{path}`, `${origin}/b/{path}`] }),
    )
    await until(() => requests.length > 0)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ failure: 'aborted' })
    expect(requests.map((r) => r.path)).toEqual(['/a/model.gguf'])
  })

  it('rejects at once when the signal has already fired', async () => {
    routes.set(hfPath(), blob(good))
    const controller = new AbortController()
    controller.abort()
    await expect(
      cachedModelFile(cache, manifest, file(), toLocal, options({ signal: controller.signal })),
    ).rejects.toMatchObject({ failure: 'aborted' })
    expect(requests).toHaveLength(0)
  })

  it('reports a full disk as disk-space without retrying', async () => {
    routes.set(hfPath(), blob(good))
    writeFault.code = 'ENOSPC'
    const error = await cachedModelFile(cache, manifest, file(), toLocal, options()).catch(
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ failure: 'disk-space' })
    expect(requests).toHaveLength(1)
  })

  it('names the model with the label and keeps the search-model text by default', async () => {
    const labelled = await cachedModelFile(
      cache,
      manifest,
      file(),
      toLocal,
      options({ label: 'local AI model' }),
    ).catch((e: unknown) => e as Error)
    expect(labelled.message).toContain('The local AI model test-org/test-model@aaaaaaaaaa')
    expect(labelled.message).not.toContain('search model')

    const plain = await cachedModelFile(cache, manifest, file(), toLocal, options()).catch(
      (e: unknown) => e as Error,
    )
    expect(plain.message).toContain('The search model test-org/test-model@aaaaaaaaaa')
    expect(plain.message).toContain('Text search keeps working.')
  })

  it('verifyModelFile accepts the pinned size and SHA-256 only', async () => {
    routes.set(hfPath(), blob(good))
    const path = await cachedModelFile(cache, manifest, file(), toLocal, options())
    expect(await verifyModelFile(path, file())).toBe(true)
    expect(await verifyModelFile(path, { ...file(), sha256: 'b'.repeat(64) })).toBe(false)
  })
})
