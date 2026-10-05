import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { publishIndexingPolicy, resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'

let dir: string
let managers: DocumentMemoryManager[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-memory-manager-'))
  managers = []
})
afterEach(() => {
  for (const manager of managers) manager.close()
  resetIndexingPolicyBus()
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
  it('retains searchable chunks when the source drive disappears during verification', async () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)
    const path = join(dir, 'company.txt')
    writeFileSync(path, 'cached company document')
    instance.remember(path)
    await until(() => instance.status().vectors > 0)
    const store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const hit = store.search('cached', null, 5)[0]!
    const source = instance as unknown as { statOutcome(path: string): Promise<{ kind: 'gone' }> }
    vi.spyOn(source, 'statOutcome').mockResolvedValue({ kind: 'gone' })
    const result = await instance.read(hit.chunkId)
    expect(result.verified).toBe(false)
    expect(result.error).toContain('temporarily unavailable')
    await (instance as unknown as { finalizeMissing(path: string): Promise<void> }).finalizeMissing(
      path,
    )
    expect(store.search('cached', null, 5)).toHaveLength(1)
    expect(store.documentByPath(path)?.status).toBe('ready')
    store.close()
  })

  it('keeps a failed embedding in the live queue and retries it without reading the file again', async () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.failEmbedding = true
    const instance = manager(fake)
    const path = join(dir, 'retry-model.txt')
    writeFileSync(path, 'A document with searchable content before vectors are ready.')
    instance.remember(path)
    await until(
      () => fake.embeddingCalls.length === 1 && instance.nowStatus().embedding[path] !== undefined,
    )
    const store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const id = store.documentByPath(path)!.id
    store.close()
    fake.failEmbedding = false
    expect(instance.retryDocument(id)).toEqual({ ok: true })
    await until(() => instance.status().vectors > 0)
    expect(fake.extractionCalls.filter((item) => item === path)).toHaveLength(1)
    expect(fake.embeddingCalls).toHaveLength(2)
  })
  it('does not show old completed counters while a changed snapshot is paused, then completes', async () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)
    const path = join(dir, 'changed.txt')
    writeFileSync(path, 'new document content')
    const store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    store.replaceDocument(path, {
      hash: 'old',
      mtimeMs: 1,
      sizeBytes: 3,
      chunks: Array.from({ length: 5 }, (_, i) => ({
        text: `old ${i}`,
        location: `${i}`,
        vector: [1, 0],
      })),
      embeddingModel: 'test-v1',
      status: 'ready',
    })
    store.close()
    const policy = {
      paused: true,
      pauseReason: 'low-memory' as const,
      threads: 1,
      cpuShare: 0,
      priority: 'idle' as const,
      tier: 'paused' as const,
      reason: 'test pause',
      onBattery: false,
    }
    publishIndexingPolicy(policy)
    instance.indexDiscoveredFile(path)
    expect(instance.getDocumentIndexProgress(path)).toMatchObject({
      state: 'paused',
      percent: null,
      completedChunks: 0,
      totalChunks: 0,
    })
    publishIndexingPolicy({ ...policy, paused: false, tier: 'active', cpuShare: 0.5 })
    await until(() => instance.getDocumentIndexProgress(path).state === 'ready')
    expect(instance.getDocumentIndexProgress(path)).toMatchObject({
      state: 'ready',
      percent: 100,
      completedChunks: 1,
      totalChunks: 1,
    })
  })

  it('reports paused partial vectors, durable errors, and folder-scoped progress', () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)
    instance.setEnabled(false)
    const selectedRoot = join(dir, 'selected')
    const partialPath = join(selectedRoot, 'partial.txt')
    const excludedPath = join(selectedRoot, 'excluded.txt')
    const outsidePath = join(dir, 'outside.txt')
    const store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    store.replaceDocument(partialPath, {
      hash: 'partial',
      mtimeMs: 1,
      sizeBytes: 2,
      chunks: [
        { text: 'one', location: '1', vector: [1, 0] },
        { text: 'two', location: '2' },
      ],
      embeddingModel: 'test-v1',
      status: 'text-only',
    })
    store.replaceDocument(excludedPath, {
      hash: 'excluded',
      mtimeMs: 1,
      sizeBytes: 1,
      chunks: [{ text: 'excluded', location: '1' }],
      embeddingModel: null,
      status: 'text-only',
    })
    store.exclude(excludedPath)
    store.replaceDocument(outsidePath, {
      hash: 'outside',
      mtimeMs: 1,
      sizeBytes: 1,
      chunks: [{ text: 'outside', location: '1', vector: [1, 0] }],
      embeddingModel: 'test-v1',
      status: 'ready',
    })

    expect(instance.getDocumentIndexProgress(partialPath)).toMatchObject({
      state: 'paused',
      percent: 50,
      completedChunks: 1,
      totalChunks: 2,
    })
    expect(instance.getFolderIndexProgress(selectedRoot, true)).toMatchObject({
      totalFiles: 1,
      readyFiles: 0,
      pendingFiles: 1,
      errorFiles: 0,
      completedChunks: 1,
      totalChunks: 2,
      percent: 50,
    })

    store.markError(partialPath, 'extract failed', null)
    expect(instance.getDocumentIndexProgress(partialPath)).toMatchObject({
      state: 'error',
      percent: null,
      completedChunks: 0,
      totalChunks: 0,
      error: 'extract failed',
    })
    expect(instance.getFolderIndexProgress(selectedRoot, true)).toMatchObject({
      totalFiles: 1,
      pendingFiles: 0,
      errorFiles: 1,
      percent: 0,
    })
    store.close()
  })

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

  it('exposes active embedding progress and promotes it without re-extracting or losing completed chunks', async () => {
    const path = join(dir, 'active-embedding.txt')
    writeFileSync(path, `${'OCR READABLE '.repeat(5000)}\n\n`)
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.delay = 50
    const instance = manager(fake)
    instance.remember(path)
    await until(() => !!instance.nowStatus().embedding[path])
    const view = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const id = view.documentByPath(path)!.id
    view.close()
    expect(instance.retryDocument(id)).toEqual({ ok: true })
    await until(
      () => instance.status().vectors === instance.status().chunks && instance.status().chunks > 0,
    )
    expect(fake.extractionCalls.filter((item) => item === path)).toHaveLength(1)
  })

  it('stops a stalled text-only embedding and keeps the document explicitly retryable', async () => {
    const path = join(dir, 'stalled-embedding.txt')
    writeFileSync(path, 'Readable text waiting for semantic indexing')
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.stopAfterBatches = 0
    const instance = manager(fake)
    instance.remember(path)
    await until(() => fake.embeddingCalls.length === 1)
    const view = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const id = view.documentByPath(path)!.id
    expect(view.documentByPath(path)?.status).toBe('text-only')
    expect(await instance.stopDocument(id)).toEqual({ ok: true })
    await until(() => !instance.nowStatus().embedding[path])
    expect(view.documentByPath(path)).toMatchObject({ status: 'error', error: 'Stopped by you.' })
    view.close()
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
    await until(() => instance.status().chunks > 0 && instance.status().modelState === 'error')
    expect(instance.status().pending).toBeGreaterThan(0)
    expect(instance.status().modelState).toBe('error')
    expect((await instance.search('rare lexical')).hits[0]?.path).toBe(path)
  })

  it('bounds extracted documents while embedding stalls and avoids rescanning all paths for priority', async () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.stopAfterBatches = 0
    const instance = manager(fake)
    const listPaths = vi.spyOn(DocumentMemoryStore.prototype, 'listPaths')
    try {
      for (let i = 0; i < 64; i++) {
        const path = join(dir, `bulk-${i}.txt`)
        writeFileSync(path, `Bulk document ${i}`)
        instance.indexDiscoveredFile(path)
      }
      await until(() => fake.embeddingCalls.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fake.extractionCalls.length).toBe(16)
      expect(listPaths).not.toHaveBeenCalled()
      expect(instance.getDocumentIndexProgress(join(dir, 'bulk-63.txt')).state).toBe('queued')
    } finally {
      listPaths.mockRestore()
    }
  })

  it('backs off failed embeddings instead of exhausting a large queue in a retry burst', async () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    fake.failEmbedding = true
    const instance = manager(fake)
    for (let i = 0; i < 48; i++) {
      const path = join(dir, `failure-${i}.txt`)
      writeFileSync(path, `Failure test ${i}`)
      instance.indexDiscoveredFile(path)
    }
    await until(() => fake.embeddingCalls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fake.embeddingCalls).toHaveLength(1)
    expect(fake.extractionCalls.length).toBeLessThanOrEqual(17)
    expect(instance.status().modelState).toBe('error')
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

  it('recycles background indexing worker gracefully without changing enabled state', async () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const terminateSpy = vi.spyOn(fake, 'terminate')
    const instance = manager(fake)
    expect(instance.status().enabled).toBe(true)

    const docPath = join(dir, 'doc.txt')
    writeFileSync(docPath, 'Sample content to index')
    instance.remember(docPath)
    await until(() => instance.status().chunks === 1)

    instance.recycleEmbeddingWorker('Model retry requested from diagnostics')
    expect(terminateSpy).toHaveBeenCalled()
    expect(instance.status().enabled).toBe(true)
    expect(instance.status().lastError).toBe('Model retry requested from diagnostics')
  })

  it('handles blocked modelState and recovers when indexing policy allows heavy embedding', async () => {
    const fake = new FakeWorker(join(dir, 'document-memory.db'))
    const instance = manager(fake)
    ;(instance as unknown as { ensureWorker(): Worker }).ensureWorker()

    // Simulate worker notifying that high embedding model is blocked by policy
    fake.emit('message', {
      type: 'model',
      state: 'blocked',
      error: 'High-accuracy embedding model disabled by indexing policy (low RAM or battery).',
    })

    expect(instance.status().modelState).toBe('blocked')
    expect(instance.status().lastError).toContain('High-accuracy embedding model disabled')

    // During blocked state, searchProgressive should skip query embedding and return lexical results cleanly
    const lexicalHits: unknown[] = []
    await instance.searchProgressive('test', 5, {
      onLexical: (hits) => lexicalHits.push(...hits),
    })
    expect(fake.embeddingCalls).toHaveLength(0)

    // When policy recovers and allows heavy embedding
    publishIndexingPolicy({
      paused: false,
      threads: 2,
      cpuShare: 0.5,
      priority: 'below-normal',
      tier: 'active',
      reason: 'test',
      onBattery: false,
      allowHeavyEmbedding: true,
    } as any)

    expect(instance.status().modelState).toBe('not-loaded')
    expect(instance.status().lastError).toBeUndefined()
  })
})
