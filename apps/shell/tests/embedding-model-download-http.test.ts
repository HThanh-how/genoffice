import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMBEDDING_PROFILES, type EmbeddingProfile } from '../src/main/document-memory/embedding-profiles'
import {
  EmbeddingModelDownloadError,
  ensureModelFiles,
  modelFilesCached,
  modelCacheFilePath,
  modelFileUrl,
  type FetchLike,
} from '../src/main/document-memory/embedding/model-files'

/**
 * The tiered manifests (repo, pinned revision, external-data layout) downloaded over real HTTP from a
 * local server: the fetch hook only swaps the host, the request path is exactly what Hugging Face would see.
 * File contents are small fixtures with their own sha256, never the real models.
 */
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

function fixtureProfile(base: EmbeddingProfile): { profile: EmbeddingProfile; blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>()
  const files = base.files.map((file, i) => {
    const data = Buffer.from(`${base.id}:${file.path}:${'x'.repeat(2000 + i * 500)}`)
    blobs.set(file.path, data)
    return { path: file.path, sha256: sha(data), bytes: data.length }
  })
  return { profile: { ...base, files }, blobs }
}

describe('model download against a local HTTP server', () => {
  let cache: string
  let server: Server
  let origin: string
  /** request path -> handler override; default serves the fixture */
  const hits: string[] = []
  let serve: (path: string, res: import('node:http').ServerResponse) => boolean = () => false
  let routes = new Map<string, Buffer>()

  const toLocal: FetchLike = (url) => fetch(url.replace('https://huggingface.co', origin))

  beforeEach(async () => {
    cache = mkdtempSync(join(tmpdir(), 'genoffice-model-http-'))
    hits.length = 0
    serve = () => false
    routes = new Map()
    server = createServer((req, res) => {
      const path = req.url ?? ''
      hits.push(path)
      if (serve(path, res)) return
      const data = routes.get(path)
      if (!data) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-length': data.length }).end(data)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(cache, { recursive: true, force: true })
  })

  const route = (profile: EmbeddingProfile, blobs: Map<string, Buffer>) => {
    for (const file of profile.files) routes.set(new URL(modelFileUrl(profile, file)).pathname, blobs.get(file.path)!)
  }
  const partFiles = () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name))
        else if (entry.name.includes('.part-') || entry.name.endsWith('.part')) found.push(join(dir, entry.name))
      }
    }
    walk(cache)
    return found
  }

  it.each(['base', 'balanced', 'mid', 'plus'] as const)('downloads every file of the %s manifest and verifies it', async (id) => {
    const { profile, blobs } = fixtureProfile(EMBEDDING_PROFILES[id])
    route(profile, blobs)
    const paths = await ensureModelFiles(cache, profile, toLocal)
    expect([...paths.keys()]).toEqual(profile.files.map((f) => f.path))
    for (const file of profile.files) {
      expect(readFileSync(paths.get(file.path)!).equals(blobs.get(file.path)!)).toBe(true)
      expect(paths.get(file.path)).toBe(modelCacheFilePath(cache, profile, file))
    }
    // the pinned revision is in every request path; the second start downloads nothing
    expect(hits.every((h) => h.includes(`/resolve/${profile.revision}/`))).toBe(true)
    const requests = hits.length
    await ensureModelFiles(cache, profile, toLocal)
    expect(hits.length).toBe(requests)
    if (id === 'mid' || id === 'plus') {
      // the external-weights file must sit next to the graph for onnxruntime to find it
      const graph = paths.get(profile.modelFile)!
      expect(existsSync(join(dirname(graph), 'model_quantized.onnx_data'))).toBe(true)
    }
  })

  it('modelFilesCached tells the settings screen whether a profile is on disk (stat only)', async () => {
    const { profile, blobs } = fixtureProfile(EMBEDDING_PROFILES.mid)
    route(profile, blobs)
    expect(modelFilesCached(cache, profile)).toBe(false)
    await ensureModelFiles(cache, profile, toLocal)
    expect(modelFilesCached(cache, profile)).toBe(true)
    writeFileSync(modelCacheFilePath(cache, profile, profile.files[2]!), 'truncated')
    expect(modelFilesCached(cache, profile)).toBe(false)
    expect(modelFilesCached(cache, EMBEDDING_PROFILES.standard)).toBe(false)
  })

  it('rejects a file whose content does not match the pinned sha256, deletes it and succeeds once the host serves the right bytes', async () => {
    const { profile, blobs } = fixtureProfile(EMBEDDING_PROFILES.mid)
    route(profile, blobs)
    const target = profile.files[1]!
    const goodPath = new URL(modelFileUrl(profile, target)).pathname
    const good = blobs.get(target.path)!
    const corrupt = Buffer.from(good)
    corrupt[10] = corrupt[10]! ^ 0xff // same length, other content
    routes.set(goodPath, corrupt)

    const error = await ensureModelFiles(cache, profile, toLocal).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(error.failure).toBe('checksum')
    expect(existsSync(modelCacheFilePath(cache, profile, target))).toBe(false)
    expect(partFiles()).toEqual([])

    routes.set(goodPath, good)
    await expect(ensureModelFiles(cache, profile, toLocal)).resolves.toBeInstanceOf(Map)
  })

  it('resumes an interrupted multi-file download: finished files are kept and not fetched again', async () => {
    const { profile, blobs } = fixtureProfile(EMBEDDING_PROFILES.mid)
    route(profile, blobs)
    const last = profile.files.at(-1)!
    const lastPath = new URL(modelFileUrl(profile, last)).pathname
    let cut = true
    serve = (path, res) => {
      if (path !== lastPath || !cut) return false
      // promise the whole file, send half of it and drop the connection
      const data = blobs.get(last.path)!
      res.writeHead(200, { 'content-length': data.length })
      res.write(data.subarray(0, Math.floor(data.length / 2)), () => res.destroy())
      return true
    }

    const error = await ensureModelFiles(cache, profile, toLocal).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(error.failure).toBe('network')
    expect(existsSync(modelCacheFilePath(cache, profile, last))).toBe(false)
    // the partial file stays (under its fixed name) so the next start can resume it
    expect(partFiles()).toEqual([`${modelCacheFilePath(cache, profile, last)}.part`])
    for (const file of profile.files.slice(0, -1)) expect(existsSync(modelCacheFilePath(cache, profile, file))).toBe(true)

    hits.length = 0
    cut = false
    const paths = await ensureModelFiles(cache, profile, toLocal)
    expect(hits).toEqual([lastPath])
    expect(readFileSync(paths.get(last.path)!).equals(blobs.get(last.path)!)).toBe(true)
    expect(partFiles()).toEqual([])
  })

  it('removes the partial file a killed process left behind before downloading again', async () => {
    const { profile, blobs } = fixtureProfile(EMBEDDING_PROFILES.base)
    route(profile, blobs)
    const file = profile.files[0]!
    const stale = `${modelCacheFilePath(cache, profile, file)}.part-123`
    mkdirSync(dirname(stale), { recursive: true })
    writeFileSync(stale, 'half a file')
    await ensureModelFiles(cache, profile, toLocal)
    expect(existsSync(stale)).toBe(false)
    expect(partFiles()).toEqual([])
  })

  it('answers 401 (the legacy private F2LLM repository) with an actionable EmbeddingModelDownloadError', async () => {
    serve = (_path, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('Invalid username or password.')
      return true
    }
    const error = await ensureModelFiles(cache, EMBEDDING_PROFILES.standard, toLocal).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(error.failure).toBe('access-denied')
    expect(error.status).toBe(401)
    expect(error.message).toContain('Choose another search model')
    expect(error.message).toContain('Text search keeps working')
    expect(hits[0]).toContain('genoffice/F2LLM-v2-80M-ONNX/resolve/')
  })

  it('reports a 404 and an unreachable server without leaking low-level details', async () => {
    const { profile } = fixtureProfile(EMBEDDING_PROFILES.base)
    const notFound = await ensureModelFiles(cache, profile, toLocal).catch((e) => e)
    expect(notFound.failure).toBe('not-found')
    await new Promise((resolve) => server.close(resolve))
    const unreachable = await ensureModelFiles(cache, profile, toLocal).catch((e) => e)
    expect(unreachable).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(unreachable.failure).toBe('network')
    expect(unreachable.message).not.toContain('127.0.0.1')
  })
})
