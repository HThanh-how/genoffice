import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMBEDDING_PROFILES, type EmbeddingProfile } from '../src/main/document-memory/embedding-profiles'
import {
  EmbeddingModelDownloadError,
  cachedModelFile,
  ensureModelFiles,
  modelCacheFilePath,
  modelFileUrl,
  type FetchLike,
} from '../src/main/document-memory/embedding/model-files'

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const body = (data: Buffer | string): Awaited<ReturnType<FetchLike>> => ({
  ok: true,
  status: 200,
  body: new Response(data).body,
})
const status = (code: number): Awaited<ReturnType<FetchLike>> => ({ ok: false, status: code, body: null })

describe('model file download', () => {
  let cache: string
  const content = Buffer.from('tokenizer-bytes')
  const profile: EmbeddingProfile = {
    ...EMBEDDING_PROFILES.base,
    files: [{ path: 'tokenizer.json', sha256: sha(content), bytes: content.length }],
    modelFile: 'tokenizer.json',
    tokenizerFile: 'tokenizer.json',
    tokenizerConfigFile: 'tokenizer.json',
  }

  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), 'genoffice-model-files-'))
  })
  afterEach(() => rmSync(cache, { recursive: true, force: true }))

  it('downloads from the pinned revision and verifies size and sha256', async () => {
    const urls: string[] = []
    const path = await cachedModelFile(cache, profile, profile.files[0]!, async (url) => {
      urls.push(url)
      return body(content)
    })
    expect(urls).toEqual([
      `https://huggingface.co/hotchpotch/bekko-embedding-v1-a8m/resolve/${profile.revision}/tokenizer.json`,
    ])
    expect(urls[0]).toBe(modelFileUrl(profile, profile.files[0]!))
    expect(path).toBe(modelCacheFilePath(cache, profile, profile.files[0]!))
    expect(readFileSync(path).equals(content)).toBe(true)
  })

  it('does not download a file it already holds and has verified', async () => {
    await cachedModelFile(cache, profile, profile.files[0]!, async () => body(content))
    const again = await ensureModelFiles(cache, profile, async () => {
      throw new Error('must not hit the network')
    })
    expect([...again.keys()]).toEqual(['tokenizer.json'])
  })

  it('fails with an actionable error when the repository answers 401 (the private F2LLM artifact)', async () => {
    const legacy = EMBEDDING_PROFILES.standard
    const file = legacy.files[0]!
    const error = await cachedModelFile(cache, legacy, file, async () => status(401)).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(error.failure).toBe('access-denied')
    expect(error.status).toBe(401)
    expect(error.message).toContain('genoffice/F2LLM-v2-80M-ONNX')
    expect(error.message).toContain('HTTP 401')
    expect(error.message).toContain('Choose another search model')
    expect(error.message).toContain(join(cache, legacy.repo, legacy.revision))
    expect(error.message).toContain('Text search keeps working')
    expect(existsSync(modelCacheFilePath(cache, legacy, file))).toBe(false)
  })

  it.each([
    [403, 'access-denied'],
    [404, 'not-found'],
    [500, 'http'],
  ] as const)('classifies HTTP %i as %s', async (code, failure) => {
    const error = await cachedModelFile(cache, profile, profile.files[0]!, async () => status(code)).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(error.failure).toBe(failure)
    expect(error.message).toContain(`${code}`)
  })

  it('reports an unreachable host without leaking the low-level error', async () => {
    const error = await cachedModelFile(cache, profile, profile.files[0]!, async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND huggingface.co')
    }).catch((e) => e)
    expect(error).toBeInstanceOf(EmbeddingModelDownloadError)
    expect(error.failure).toBe('network')
    expect(error.message).not.toContain('ENOTFOUND')
    expect(error.message).toContain('internet connection')
  })

  it('deletes a download whose checksum does not match', async () => {
    const wrong = Buffer.from('tokenizer-BYTES') // same length, other content
    const error = await cachedModelFile(cache, profile, profile.files[0]!, async () => body(wrong)).catch((e) => e)
    expect(error.failure).toBe('checksum')
    expect(existsSync(modelCacheFilePath(cache, profile, profile.files[0]!))).toBe(false)
  })

  it('deletes a download of the wrong size', async () => {
    const error = await cachedModelFile(cache, profile, profile.files[0]!, async () => body('short')).catch((e) => e)
    expect(error.failure).toBe('size')
    expect(existsSync(modelCacheFilePath(cache, profile, profile.files[0]!))).toBe(false)
  })

  it('re-downloads a cached file that was tampered with', async () => {
    const path = await cachedModelFile(cache, profile, profile.files[0]!, async () => body(content))
    rmSync(`${path}.verified`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, Buffer.from('tokenizer-BYTES'))
    let fetched = 0
    await cachedModelFile(cache, profile, profile.files[0]!, async () => {
      fetched++
      return body(content)
    })
    expect(fetched).toBe(1)
    expect(readFileSync(path).equals(content)).toBe(true)
  })
})
