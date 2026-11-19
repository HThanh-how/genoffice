import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureArtifact, deleteArtifact } from '../src/main/model-artifacts/model-files'
import { acquireDownloadLock } from '../src/main/model-artifacts/download-lock'
import type { FetchLike } from '../src/main/model-artifacts/model-transfer'
import { localChatCopy } from '../src/renderer/src/i18n/strings-local-chat'
import { LANGS } from '@genoffice/i18n'
import { LocalModelManager } from '../src/main/local-model/manager'
import { downloadNetwork } from '../src/main/local-model/network'

let dir: string
const file = {
  path: 'test.gguf',
  bytes: 8,
  sha256: createHash('sha256').update('gooddata').digest('hex'),
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-artifacts-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const response = (text: string, status = 200, headers?: Record<string, string>) =>
  new Response(text, { status, headers })

describe('shared local artifacts', () => {
  it('pauses automatic downloads offline or on Windows metered connections', async () => {
    const probe = vi.fn(async () => 'Fixed')
    expect(await downloadNetwork(false, 'win32', probe)).toBe('offline')
    expect(probe).not.toHaveBeenCalled()
    expect(await downloadNetwork(true, 'win32', probe)).toBe('metered')
    expect(await downloadNetwork(true, 'win32', async () => 'Variable')).toBe('metered')
    expect(await downloadNetwork(true, 'win32', async () => 'Unrestricted')).toBe('online')
    expect(
      await downloadNetwork(true, 'win32', async () => {
        throw new Error('Unavailable')
      }),
    ).toBe('unknown')
  })
  it('checks SHA and size, ignores a stale marker and same mtime, and deletes bad bytes', async () => {
    const destination = join(dir, file.path)
    const network = vi.fn<FetchLike>().mockResolvedValue(response('gooddata'))
    await ensureArtifact(
      destination,
      file,
      'https://huggingface.co/test',
      new AbortController().signal,
      () => {},
      network,
    )
    const before = await stat(destination)
    await writeFile(`${destination}.verified`, `${file.sha256}:8`)
    await writeFile(destination, 'evildata')
    await utimes(destination, before.atime, before.mtime)
    await expect(
      ensureArtifact(
        destination,
        file,
        'https://huggingface.co/test',
        new AbortController().signal,
        () => {},
        network,
      ),
    ).rejects.toMatchObject({ code: 'MODEL_CHECKSUM' })
    expect(await stat(destination).catch(() => null)).toBe(null)
    await expect(
      ensureArtifact(
        destination,
        file,
        'https://huggingface.co/test',
        new AbortController().signal,
        () => {},
        async () => response('evildata'),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_CHECKSUM' })
    expect(await stat(`${destination}.part`).catch(() => null)).toBe(null)
    await expect(
      ensureArtifact(
        destination,
        file,
        'https://huggingface.co/test',
        new AbortController().signal,
        () => {},
        async () => response('short'),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_SIZE' })
  })
  it('resumes an interrupted partial with Range and validates before promotion', async () => {
    const destination = join(dir, file.path)
    await writeFile(`${destination}.part`, 'good')
    const fetcher = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      expect(init?.headers?.Range).toBe('bytes=4-')
      return response('data', 206, { 'content-range': 'bytes 4-7/8', 'content-length': '4' })
    })
    await ensureArtifact(
      destination,
      file,
      'https://huggingface.co/test',
      new AbortController().signal,
      () => {},
      fetcher,
    )
    expect(await readFile(destination, 'utf8')).toBe('gooddata')
  })
  it('aborts an active transfer after a written chunk and keeps that prefix for resume', async () => {
    const destination = join(dir, file.path)
    const abort = new AbortController()
    const fetcher: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('good'))
          },
        }),
      )
    await expect(
      ensureArtifact(
        destination,
        file,
        'https://huggingface.co/test',
        abort.signal,
        (bytes) => {
          if (bytes === 4) abort.abort()
        },
        fetcher,
      ),
    ).rejects.toThrow()
    expect(await readFile(`${destination}.part`, 'utf8')).toBe('good')
    await ensureArtifact(
      destination,
      file,
      'https://huggingface.co/test',
      new AbortController().signal,
      () => {},
      async (_url, init) => {
        expect(init?.headers?.Range).toBe('bytes=4-')
        return response('data', 206, { 'content-range': 'bytes 4-7/8' })
      },
    )
    expect(await readFile(destination, 'utf8')).toBe('gooddata')
  })
  it('cancels while waiting without changing another owner’s partial, and refuses delete', async () => {
    const destination = join(dir, file.path)
    const release = await acquireDownloadLock(`${destination}.part.lock`, 0)
    await writeFile(`${destination}.part`, 'good')
    const abort = new AbortController()
    const pending = ensureArtifact(
      destination,
      file,
      'https://huggingface.co/test',
      abort.signal,
      () => {},
    )
    const rejection = expect(pending).rejects.toThrow()
    abort.abort()
    await rejection
    expect(await readFile(`${destination}.part`, 'utf8')).toBe('good')
    await expect(deleteArtifact(destination)).rejects.toThrow('another process')
    await release!()
    await deleteArtifact(destination)
  })
  it('reports network errors with resumable data preserved', async () => {
    const destination = join(dir, file.path)
    await writeFile(`${destination}.part`, 'good')
    await expect(
      ensureArtifact(
        destination,
        file,
        'https://huggingface.co/test',
        new AbortController().signal,
        () => {},
        async () => {
          throw new Error('offline')
        },
      ),
    ).rejects.toThrow('network')
    expect(await readFile(`${destination}.part`, 'utf8')).toBe('good')
  })
  it('checks all locale keys including Vietnamese and Hungarian', () => {
    for (const lang of LANGS)
      expect(Object.keys(localChatCopy(lang))).toEqual(Object.keys(localChatCopy('zh')))
    expect(localChatCopy('vi').thinking).toContain('chậm')
    expect(localChatCopy('hu').ready).toBe('Kész')
  })
  it('reports missing model explicitly and awaits host shutdown before deleting', async () => {
    const stop = vi.fn(async () => {})
    const manager = new LocalModelManager(dir, stop)
    await manager.refresh()
    expect(manager.state.status).toBe('missing')
    expect(() => manager.requireReady()).toThrow('Not downloaded')
    await manager.delete()
    expect(stop).toHaveBeenCalledOnce()
    expect(manager.state.status).toBe('missing')
  })
})
