import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  FetchLike,
  ModelArtifactManifest,
} from '../src/main/document-memory/embedding/model-files'
import {
  DISK_SPACE_MARGIN_BYTES,
  createLocalModelManager,
  type LocalModelManagerOptions,
} from '../src/main/local-model/local-model-manager'
import { LFM3_VL_2B_Q4_K_M, LOCAL_MODELS_DIR_NAME } from '../src/main/local-model/local-model-spec'

/**
 * The local model manager against a real local HTTP server and a temp userData folder. The real
 * model is 1.1 GB, so the transitions run on a small manifest of the same shape.
 */
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const SIZE = 150_000
type Handler = (req: IncomingMessage, res: ServerResponse) => void

function blob(data: Buffer, opts: { stallAt?: number; cutAt?: number } = {}): Handler {
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
    const limit = opts.stallAt ?? opts.cutAt
    if (limit === undefined) return void res.end(body)
    res.write(body.subarray(0, limit), () => {
      if (opts.cutAt !== undefined) setTimeout(() => res.destroy(), 30)
    })
  }
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('LFM3 local model spec', () => {
  it('pins one file of Hugging Face LiquidAI/LFM3-VL-2B-GGUF by revision, size and SHA-256', () => {
    expect(LFM3_VL_2B_Q4_K_M.repo).toBe('LiquidAI/LFM3-VL-2B-GGUF')
    expect(LFM3_VL_2B_Q4_K_M.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(LFM3_VL_2B_Q4_K_M.mirrorable).toBe(false)
    expect(LFM3_VL_2B_Q4_K_M.files).toEqual([
      {
        path: 'LFM3-VL-2B-Q4_K_M.gguf',
        sha256: '56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb',
        bytes: 1_099_627_808,
      },
    ])
  })

  it('is the default manifest and lives under userData/local-models', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'genoffice-local-model-default-'))
    try {
      const manager = createLocalModelManager({ userDataPath: userData })
      expect(manager.modelsDir).toBe(join(userData, LOCAL_MODELS_DIR_NAME))
      expect(await manager.refresh()).toMatchObject({
        status: 'not-installed',
        modelId: 'lfm3-vl-2b-q4_k_m',
        totalBytes: 1_099_627_808,
      })
      expect(manager.readyPath()).toBeNull()
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

describe('local model manager', () => {
  let userData: string
  let server: Server
  let origin: string
  let good: Buffer
  let manifest: ModelArtifactManifest
  const requests: Array<{ path: string; range?: string }> = []
  let routes = new Map<string, Handler>()
  const file = () => manifest.files[0]!
  const hfPath = () => `/hf/${manifest.repo}/resolve/${manifest.revision}/${file().path}`
  const cachedPath = () =>
    join(userData, LOCAL_MODELS_DIR_NAME, manifest.repo, manifest.revision, file().path)
  const toLocal: FetchLike = (url, init) =>
    fetch(url.replace('https://huggingface.co', `${origin}/hf`), init)
  const manager = (extra: Partial<LocalModelManagerOptions> = {}) =>
    createLocalModelManager({
      userDataPath: userData,
      manifest,
      fetchImpl: toLocal,
      freeBytes: async () => null,
      retryDelaysMs: [0, 0],
      stallTimeoutMs: 5000,
      ...extra,
    })

  beforeEach(async () => {
    userData = mkdtempSync(join(tmpdir(), 'genoffice-local-model-'))
    good = randomBytes(SIZE)
    manifest = {
      id: 'test-local-model',
      repo: 'test-org/test-model-GGUF',
      revision: 'c'.repeat(40),
      files: [{ path: 'Test-Q4_K_M.gguf', sha256: sha(good), bytes: SIZE }],
      mirrorable: false,
    }
    requests.length = 0
    routes = new Map()
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
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(userData, { recursive: true, force: true })
  })

  it('downloads into userData/local-models/<repo>/<revision> and becomes ready', async () => {
    routes.set(hfPath(), blob(good))
    const m = manager()
    expect((await m.refresh()).status).toBe('not-installed')
    const state = await m.download()
    expect(state).toMatchObject({ status: 'ready', source: 'downloaded', path: cachedPath() })
    expect(m.readyPath()).toBe(cachedPath())
    expect(readFileSync(cachedPath()).equals(good)).toBe(true)
    // a second download is a no-op once the model is there
    await m.download()
    expect(requests).toHaveLength(1)
  })

  it('reports a SHA-256 mismatch as checksum and deletes the bytes', async () => {
    routes.set(hfPath(), blob(randomBytes(SIZE)))
    const state = await manager().download()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('checksum')
    expect(state.error?.message).toContain('local AI model')
    expect(existsSync(cachedPath())).toBe(false)
  })

  it('refuses to start without enough free disk space', async () => {
    routes.set(hfPath(), blob(good))
    const state = await manager({ freeBytes: async () => SIZE + DISK_SPACE_MARGIN_BYTES - 1 }).download()
    expect(state).toMatchObject({ status: 'error', error: { code: 'disk-space' } })
    expect(requests).toHaveLength(0)
  })

  it('keeps the partial file after a network failure and resumes it on the next download', async () => {
    routes.set(hfPath(), blob(good, { cutAt: 40_000 }))
    const m = manager()
    const failed = await m.download()
    expect(failed.status).toBe('error')
    expect(failed.error?.code).toBe('network')
    expect(failed.partialBytes).toBeGreaterThan(0)

    routes.set(hfPath(), blob(good))
    const ready = await m.download()
    expect(ready.status).toBe('ready')
    expect(requests.at(-1)!.range).toBe(`bytes=${failed.partialBytes}-`)
  })

  it('cancel stops the download and deletes the partial file', async () => {
    routes.set(hfPath(), blob(good, { stallAt: 30_000 }))
    const m = manager()
    const pending = m.download()
    await until(() => existsSync(`${cachedPath()}.part`) && statSync(`${cachedPath()}.part`).size > 0)
    expect(m.state().status).toBe('downloading')
    const cancelled = await m.cancel()
    expect(cancelled.status).toBe('not-installed')
    expect((await pending).status).toBe('not-installed')
    expect(existsSync(`${cachedPath()}.part`)).toBe(false)
    expect(m.readyPath()).toBeNull()
  })

  it('reports an unreachable repository as unavailable', async () => {
    const state = await manager().download() // no route: 404
    expect(state).toMatchObject({ status: 'error', error: { code: 'unavailable' } })
  })

  describe('selectExisting', () => {
    it('accepts a renamed copy on size and SHA-256 and never writes next to it', async () => {
      const dir = join(userData, 'elsewhere')
      mkdirSync(dir)
      const copy = join(dir, 'my-renamed-model.bin')
      writeFileSync(copy, good)
      const m = manager()
      const result = await m.selectExisting(copy)
      expect(result.ok).toBe(true)
      expect(result.state).toMatchObject({ status: 'ready', source: 'selected', path: copy })
      expect(m.readyPath()).toBe(copy)
      expect(existsSync(`${copy}.verified`)).toBe(false)
      expect(requests).toHaveLength(0)
    })

    it('rejects a file of the right size but the wrong SHA-256, and leaves it alone', async () => {
      const other = join(userData, 'other.gguf')
      const bytes = randomBytes(SIZE)
      writeFileSync(other, bytes)
      const result = await manager().selectExisting(other)
      expect(result).toMatchObject({ ok: false, error: { code: 'wrong-model' } })
      expect(result.state.status).toBe('error')
      expect(readFileSync(other).equals(bytes)).toBe(true)
    })

    it('rejects a wrong size at once and a missing or relative path', async () => {
      const small = join(userData, 'small.gguf')
      writeFileSync(small, randomBytes(10))
      const m = manager()
      expect(await m.selectExisting(small)).toMatchObject({ ok: false, error: { code: 'wrong-model' } })
      expect(await m.selectExisting(join(userData, 'nope.gguf'))).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      })
      expect(await m.selectExisting('relative/model.gguf')).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      })
    })

    it('a wrong pick does not hide a model that is already ready', async () => {
      routes.set(hfPath(), blob(good))
      const m = manager()
      await m.download()
      const other = join(userData, 'other.gguf')
      writeFileSync(other, randomBytes(SIZE))
      const result = await m.selectExisting(other)
      expect(result.ok).toBe(false)
      expect(m.state()).toMatchObject({ status: 'ready', source: 'downloaded' })
    })
  })

  describe('delete', () => {
    it('removes a downloaded model', async () => {
      routes.set(hfPath(), blob(good))
      const m = manager()
      await m.download()
      expect((await m.delete()).status).toBe('not-installed')
      expect(existsSync(cachedPath())).toBe(false)
      expect(existsSync(`${cachedPath()}.verified`)).toBe(false)
      expect(m.readyPath()).toBeNull()
    })

    it('forgets a chosen file but never deletes it', async () => {
      const copy = join(userData, 'mine.gguf')
      writeFileSync(copy, good)
      const m = manager()
      await m.selectExisting(copy)
      expect((await m.delete()).status).toBe('not-installed')
      expect(readFileSync(copy).equals(good)).toBe(true)
      expect((await manager().refresh()).status).toBe('not-installed')
    })
  })

  describe('state after a restart', () => {
    it('finds a downloaded model and a chosen file again', async () => {
      routes.set(hfPath(), blob(good))
      await manager().download()
      expect(await manager().refresh()).toMatchObject({ status: 'ready', source: 'downloaded' })

      const copy = join(userData, 'mine.gguf')
      writeFileSync(copy, good)
      await manager().selectExisting(copy)
      expect(await manager().refresh()).toMatchObject({ status: 'ready', source: 'selected', path: copy })
    })

    it('reports a partial download as not installed with resumable bytes', async () => {
      routes.set(hfPath(), blob(good, { cutAt: 40_000 }))
      await manager().download()
      // the last failure is not remembered across a restart, the bytes are: not installed, resumable
      const state = await manager().refresh()
      expect(state.status).toBe('not-installed')
      expect(state.error).toBeUndefined()
      expect(state.partialBytes).toBeGreaterThan(0)
    })

    it('deletes a downloaded file that no longer matches its SHA-256', async () => {
      routes.set(hfPath(), blob(good))
      await manager().download()
      const tampered = Buffer.from(good)
      tampered[0] = tampered[0]! ^ 0xff
      writeFileSync(cachedPath(), tampered)
      rmSync(`${cachedPath()}.verified`, { force: true })
      const state = await manager().refresh()
      expect(state).toMatchObject({ status: 'error', error: { code: 'checksum' } })
      expect(existsSync(cachedPath())).toBe(false)
    })

    it('reports a chosen file that has been moved away', async () => {
      const copy = join(userData, 'mine.gguf')
      writeFileSync(copy, good)
      await manager().selectExisting(copy)
      renameSync(copy, join(userData, 'moved.gguf'))
      expect(await manager().refresh()).toMatchObject({ status: 'error', error: { code: 'not-found' } })
    })
  })
})
