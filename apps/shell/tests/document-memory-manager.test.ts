import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

let dir: string
let managers: DocumentMemoryManager[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-memory-manager-'))
  managers = []
})
afterEach(() => {
  for (const manager of managers) manager.close()
  rmSync(dir, { recursive: true, force: true })
})

class FakeWorker extends EventEmitter {
  delay = 0
  failEmbedding = false
  embeddingCalls: string[][] = []
  extractionCalls: string[] = []
  stopAfterBatches = Infinity
  constructor(private readonly dbPath: string) {
    super()
  }
  postMessage(message: {
    id: number
    type: string
    path?: string
    texts?: string[]
    query?: string
    vector?: number[] | null
    limit?: number
    embeddingModel?: string
  }) {
    setTimeout(() => {
      try {
        if (message.type === 'extract') {
          this.extractionCalls.push(message.path!)
          const bytes = readFileSync(message.path!)
          const text = bytes.toString('utf8')
          const stat = statSync(message.path!)
          this.emit('message', {
            id: message.id,
            result: {
              hash: createHash('sha256').update(bytes).digest('hex'),
              mtimeMs: stat.mtimeMs,
              sizeBytes: stat.size,
              chunks: chunkDocumentText(text),
              status: 'text-only',
            },
          })
        } else if (message.type === 'embed') {
          this.embeddingCalls.push(message.texts ?? [])
          if (this.embeddingCalls.length > this.stopAfterBatches) return
          if (this.failEmbedding) {
            this.emit('message', { type: 'model', state: 'error', error: 'model unavailable' })
            this.emit('message', { id: message.id, error: 'model unavailable' })
          } else {
            this.emit('message', { type: 'model', state: 'ready' })
            this.emit('message', {
              id: message.id,
              result: (message.texts ?? []).map(() => [1, 0]),
            })
          }
        } else {
          const store = new DocumentMemoryStore(this.dbPath)
          const result = store.search(
            message.query ?? '',
            message.vector ?? null,
            message.limit ?? 8,
            message.embeddingModel,
          )
          store.close()
          this.emit('message', { id: message.id, result })
        }
      } catch (error) {
        this.emit('message', {
          id: message.id,
          error: error instanceof Error ? error.message : 'failed',
        })
      }
    }, this.delay)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

async function until(check: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for manager')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function manager(fake: FakeWorker) {
  const instance = new DocumentMemoryManager(dir, {
    pollIntervalMs: 60_000,
    workerFactory: (_path, data) => {
      // Assert the worker and index share one SQLite database and a private cache folder.
      expect(data.dbPath).toBe(join(dir, 'document-memory.db'))
      expect(data.cacheDir).toContain('document-memory-models')
      return fake as unknown as Worker
    },
  })
  managers.push(instance)
  return instance
}

describe('DocumentMemoryManager', () => {
  it('indexes folder-discovered files once without turning rescans into recent opens', async () => {
    const path = join(dir, 'folder-file.txt')
    writeFileSync(path, 'discovered content that gets embedded')
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)

    expect(instance.indexDiscoveredFile(path)).toBe(true)
    await until(() => instance.status().vectors > 0 && instance.status().pending === 0)
    expect(instance.indexDiscoveredFile(path)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(fake.extractionCalls).toEqual([path])
    expect(fake.embeddingCalls).toHaveLength(1)
  })

  it('starts pending extraction with the most recently opened file', async () => {
    const oldPath = join(dir, 'old-pending.txt')
    const recentPath = join(dir, 'recent-pending.txt')
    writeFileSync(oldPath, 'older queued content')
    writeFileSync(recentPath, 'newer queued content')
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)
    instance.setEnabled(false)
    instance.remember(oldPath)
    await new Promise((resolve) => setTimeout(resolve, 5))
    instance.remember(recentPath)
    instance.setEnabled(true)
    await until(() => fake.extractionCalls.length >= 2)
    expect(fake.extractionCalls[0]).toBe(recentPath)
  })

  it('resumes committed batches after shutdown without re-embedding finished chunks', async () => {
    const path = join(dir, 'interrupted.txt')
    const text = Array.from({ length: 10 }, (_, i) => `Section ${i}: ${'A'.repeat(550)}`).join(
      '\n\n',
    )
    writeFileSync(path, text)
    const chunks = chunkDocumentText(text)
    const secondPath = join(dir, 'zz-other.txt')
    writeFileSync(secondPath, text)
    const interrupted = new FakeWorker(join(dir, 'document-memory.db'))
    interrupted.stopAfterBatches = 1
    const first = manager(interrupted)
    first.remember(path)
    first.remember(secondPath)
    await until(() => first.status().vectors === 8)
    const checkpoint = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const idsBefore = checkpoint.search('Section', null, 20).map((hit) => hit.chunkId)
    checkpoint.close()
    first.close()
    const resumedWorker = new FakeWorker(join(dir, 'document-memory.db'))
    const reopened = manager(resumedWorker)
    await until(
      () => reopened.status().vectors === chunks.length * 2 && reopened.status().pending === 0,
    )
    // Priority can resume either file first; only the unfinished vectors may be computed.
    expect(resumedWorker.embeddingCalls.flat().sort()).toEqual(
      [...chunks, ...chunks.slice(8)].map((chunk) => chunk.text).sort(),
    )
    const completed = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const idsAfter = completed.search('Section', null, 20).map((hit) => hit.chunkId)
    completed.close()
    expect(idsAfter.sort((a, b) => a - b)).toEqual(idsBefore.sort((a, b) => a - b))
    expect(reopened.status().files[0]?.status).toBe('ready')
  })

  it('restarts pending extraction when shutdown happened before text was committed', async () => {
    const path = join(dir, 'not-extracted.txt')
    writeFileSync(path, 'Pending content after reopening')
    const first = manager(new FakeWorker(join(dir, 'document-memory.db')))
    first.setEnabled(false)
    first.remember(path)
    first.setEnabled(true)
    first.close()
    const reopened = manager(new FakeWorker(join(dir, 'document-memory.db')))
    await until(() => reopened.status().vectors === 1)
    expect((await reopened.search('Pending content')).hits[0]?.path).toBe(path)
  })

  it('indexes opened files, adds vectors, searches, and verifies reads against current content', async () => {
    const path = join(dir, 'opened.txt')
    writeFileSync(path, 'Lớp 2-1 học cộng 7 + 5 = 12')
    const instance = manager(new FakeWorker(join(dir, 'document-memory.db')))
    instance.remember(path)
    await until(() => instance.status().vectors === 1)
    const result = await instance.search('lop2 1', 4)
    expect(result.hits[0]?.path).toBe(path)
    const verified = await instance.read(result.hits[0]!.chunkId)
    expect(verified.verified).toBe(true)
    expect(verified.text).toContain('12')
    writeFileSync(path, 'Updated answer is 13')
    const stale = await instance.read(result.hits[0]!.chunkId)
    expect(stale.verified).toBe(false)
    expect(stale.error).toContain('changed')
    expect(instance.status().chunks).toBe(1)
  })

  it('does not repopulate the store when clear races with extraction', async () => {
    const path = join(dir, 'slow.txt')
    writeFileSync(path, 'slow extraction')
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.delay = 80
    const instance = manager(fake)
    instance.remember(path)
    instance.clear()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(instance.status().documents).toBe(0)
    expect(instance.status().chunks).toBe(0)
  })

  it('excludes a document while a fresh read is in flight without reviving it', async () => {
    const path = join(dir, 'exclude-read.txt')
    writeFileSync(path, 'read this content')
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)
    instance.remember(path)
    await until(() => instance.status().chunks > 0)
    fake.delay = 80
    const read = instance.read(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    instance.exclude(path)
    const result = await read
    expect(result.verified).toBe(false)
    expect(instance.status().documents).toBe(0)
    expect(instance.listPaths()).toEqual([])
  })

  it('keeps passage embedding batches of more than eight chunks on the same document', async () => {
    const path = join(dir, 'many-chunks.txt')
    writeFileSync(path, `${'A'.repeat(550)}\n\n`.repeat(10))
    const instance = manager(new FakeWorker(join(dir, 'document-memory.db')))
    instance.remember(path)
    await until(
      () => instance.status().chunks > 8 && instance.status().vectors === instance.status().chunks,
    )
    expect(instance.status().chunks).toBeGreaterThan(8)
    expect(instance.status().vectors).toBe(instance.status().chunks)
    expect(instance.status().errors).toBe(0)
  })

  it('rotates large embedding jobs so a newly opened file gets a prompt batch', async () => {
    const largePath = join(dir, 'large-old.txt')
    const newerPath = join(dir, 'new-small.txt')
    writeFileSync(largePath, `${'LARGEDOC '.repeat(5000)}\n\n`)
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.delay = 5
    const instance = manager(fake)
    instance.remember(largePath)
    await until(() => fake.embeddingCalls.length > 0)
    writeFileSync(newerPath, 'NEWLYOPENED marker content')
    instance.remember(newerPath)
    await until(() =>
      fake.embeddingCalls.some((batch) => batch.some((text) => text.includes('NEWLYOPENED'))),
    )
    const newBatch = fake.embeddingCalls.findIndex((batch) =>
      batch.some((text) => text.includes('NEWLYOPENED')),
    )
    expect(newBatch).toBeLessThan(4)
  })

  it('does not restore old text when a file changes during passage embedding', async () => {
    const path = join(dir, 'changing.txt')
    writeFileSync(path, 'old unique phrase')
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.delay = 80
    const instance = manager(fake)
    instance.remember(path)
    await until(() => instance.status().chunks > 0 && instance.status().vectors === 0)
    writeFileSync(path, 'new replacement content')
    instance.remember(path)
    await until(() => instance.status().vectors === 1 && instance.status().pending === 0)
    const result = await instance.search('new replacement')
    expect(result.hits[0]?.path).toBe(path)
    expect(result.hits[0]?.text).toContain('new replacement')
    expect(result.hits[0]?.text).not.toContain('old unique')
  })

  it('keeps lexical search available when local embedding initialization fails', async () => {
    const path = join(dir, 'text-only.txt')
    writeFileSync(path, 'rare lexical content')
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.failEmbedding = true
    const instance = manager(fake)
    instance.remember(path)
    await until(() => instance.status().chunks > 0 && instance.status().pending === 0)
    expect(instance.status().modelState).toBe('error')
    expect((await instance.search('rare lexical')).hits[0]?.path).toBe(path)
  })

  it('persists enabled state and never enrolls a path moved from an unknown source', () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)
    expect(instance.status().enabled).toBe(true)
    expect(instance.setEnabled(false).enabled).toBe(false)
    instance.close()
    const reopened = manager(new FakeWorker(join(dir, 'document-memory.db')))
    expect(reopened.status().enabled).toBe(false)
    const pausedPath = join(dir, 'paused.txt')
    writeFileSync(pausedPath, 'wait until enabled')
    reopened.remember(pausedPath)
    expect(reopened.status().chunks).toBe(0)
    reopened.setEnabled(true)
    return until(() => reopened.status().chunks === 1).then(() => {
      reopened.move(join(dir, 'unknown.txt'), join(dir, 'new.txt'))
      expect(reopened.listPaths()).toEqual([pausedPath])
    })
  })
})
