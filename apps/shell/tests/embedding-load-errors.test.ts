import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posted: Array<Record<string, unknown>> = []
vi.mock('../src/main/document-memory/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/document-memory/runtime')>()),
  postIndexMessage: (message: Record<string, unknown>) => posted.push(message),
}))

import { embedTexts, overrideModelWaitMs } from '../src/main/document-memory/embeddings'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { overrideInstalledOrtVersion } from '../src/main/document-memory/embedding/ort-support'
import { EmbeddingModelDownloadError } from '../src/main/document-memory/embedding/model-files'

describe('embedTexts failure reporting', () => {
  let cache: string
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), 'genoffice-embed-errors-'))
    posted.length = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    overrideModelWaitMs(undefined)
    overrideInstalledOrtVersion(undefined)
    rmSync(cache, { recursive: true, force: true })
  })

  it('turns the 401 of the private legacy artifact repository into an actionable model error, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })))
    const error = await embedTexts(['xin chào'], 'passage', cache, EMBEDDING_PROFILES.standard).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    const modelMessages = posted.filter((m) => m.type === 'model')
    expect(modelMessages.map((m) => m.state)).toEqual(['downloading', 'error'])
    const reported = String(modelMessages[1]!.error)
    expect(reported).toContain('genoffice/F2LLM-v2-80M-ONNX')
    expect(reported).toContain('HTTP 401')
    expect(reported).toContain('Choose another search model')
    expect(reported).toContain('Text search keeps working')
  })

  it('does not leak low-level errors of other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connect ECONNREFUSED 10.0.0.1:443') }))
    const error = await embedTexts(['x'], 'query', cache, EMBEDDING_PROFILES.standard).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(String(posted.at(-1)!.error)).not.toContain('ECONNREFUSED')
    expect(String(posted.at(-1)!.error)).toContain('internet connection')
  })

  it('refuses the Gemma export on an onnxruntime-node that cannot load it, before any download', async () => {
    overrideInstalledOrtVersion('1.21.0')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(embedTexts(['x'], 'query', cache, EMBEDDING_PROFILES.mid)).rejects.toThrow('ONNX Runtime 1.23.0 or newer')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(posted).toEqual([expect.objectContaining({ type: 'model', state: 'error' })])
    expect(String(posted[0]!.error)).toContain('Base or Balanced')
  })

  it('answers "still being prepared" instead of holding the worker queue while the download continues, and reports progress', async () => {
    const files = EMBEDDING_PROFILES.base.files
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const half = (n: number) => new Uint8Array(Math.floor(n / 2))
    // the first file streams half of its bytes, then waits: a slow host
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        let sent = false
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(half(files[0]!.bytes!))
              return
            }
            await gate
            controller.error(new TypeError('connection lost'))
          },
        })
        return new Response(body, { status: 200, headers: { 'content-length': String(files[0]!.bytes) } })
      }),
    )
    overrideModelWaitMs(100)
    const error = await embedTexts(['x'], 'passage', cache, EMBEDDING_PROFILES.base).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(EmbeddingModelDownloadError)
    expect(String(error.message)).toContain('still being prepared')
    // the model is still downloading: no 'error' state, and a percentage was reported
    const models = posted.filter((m) => m.type === 'model')
    expect(models[0]).toEqual({ type: 'model', state: 'downloading' })
    expect(models.every((m) => m.state === 'downloading')).toBe(true)
    expect(models.some((m) => typeof m.progress === 'number' && typeof m.source === 'string')).toBe(true)
    // a failure that happens while nobody waits must not become an unhandled rejection
    release()
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
})
