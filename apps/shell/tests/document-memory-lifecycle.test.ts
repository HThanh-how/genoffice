import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'

let dir: string
let managers: DocumentMemoryManager[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-memory-lifecycle-'))
  managers = []
})
afterEach(() => {
  for (const manager of managers) manager.close()
  rmSync(dir, { recursive: true, force: true })
})

class FakeWorker extends EventEmitter {
  embeddingCalls: string[][] = []
  extractionCalls: string[] = []
  skipEmbeddings = false
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
          const stat = statSync(message.path!)
          this.emit('message', {
            id: message.id,
            result: {
              hash: createHash('sha256').update(bytes).digest('hex'),
              mtimeMs: stat.mtimeMs,
              sizeBytes: stat.size,
              chunks: chunkDocumentText(bytes.toString('utf8')),
              status: 'text-only',
              ...(this.skipEmbeddings ? { skipEmbeddings: true, truncated: true } : {}),
            },
          })
        } else if (message.type === 'embed') {
          this.embeddingCalls.push(message.texts ?? [])
          this.emit('message', { type: 'model', state: 'ready' })
          this.emit('message', {
            id: message.id,
            result: (message.texts ?? []).map(() =>
              new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1),
            ),
          })
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
    }, 0)
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

function setup(graceMs = 20) {
  const dbPath = join(dir, 'document-memory.db')
  const fake = new FakeWorker(dbPath)
  const instance = new DocumentMemoryManager(dir, {
    pollIntervalMs: 60_000,
    tombstoneGraceMs: graceMs,
    workerFactory: () => fake as unknown as Worker,
  })
  managers.push(instance)
  const read = <T>(work: (store: DocumentMemoryStore) => T): T => {
    const store = new DocumentMemoryStore(dbPath)
    try {
      return work(store)
    } finally {
      store.close()
    }
  }
  return { fake, instance, read }
}

async function indexed(
  ctx: ReturnType<typeof setup>,
  name: string,
  text: string,
  folder = dir,
): Promise<string> {
  const path = join(folder, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path, text)
  ctx.instance.indexDiscoveredFile(path)
  await until(() => ctx.read((store) => store.documentByPath(path)?.status === 'ready'))
  return path
}

describe('query-time freshness', () => {
  it('flags a hit stale after its file changed and queues a prioritized re-index', async () => {
    const ctx = setup()
    const path = await indexed(ctx, 'fresh.txt', 'quarterly budget approved by finance')
    const first = await ctx.instance.search('quarterly budget')
    expect(first.hits[0]).toMatchObject({ path, stale: false, missing: false, truncated: false })
    expect(first.hits[0]!.indexedAt).toBeGreaterThan(0)

    writeFileSync(path, 'quarterly budget rejected, completely different content now')
    const bumped = new Date(Date.now() + 5_000)
    utimesSync(path, bumped, bumped)
    const calls = ctx.fake.extractionCalls.length
    const second = await ctx.instance.search('quarterly budget')
    expect(second.hits[0]).toMatchObject({ path, stale: true, missing: false })
    await until(() => ctx.fake.extractionCalls.length > calls)
    await until(() => ctx.read((store) => store.documentByPath(path)?.status === 'ready'))
    const third = await ctx.instance.search('rejected')
    expect(third.hits[0]).toMatchObject({ path, stale: false })
  })

  it('flags a hit missing when its file was deleted, without hashing', async () => {
    const ctx = setup(60_000)
    const path = await indexed(ctx, 'gone.txt', 'unique zebra migration schedule')
    rmSync(path)
    const result = await ctx.instance.search('zebra migration')
    expect(result.hits[0]).toMatchObject({ path, stale: true, missing: true })
  })
})

describe('tombstones and move detection', () => {
  it('deletes chunks, FTS rows and vectors once a file is gone but keeps exclusions', async () => {
    const ctx = setup()
    const doomed = await indexed(ctx, 'doomed.txt', 'ephemeral aardvark ledger')
    const excluded = await indexed(ctx, 'excluded.txt', 'excluded narwhal ledger')
    ctx.instance.exclude(excluded)
    rmSync(excluded)
    rmSync(doomed)
    await ctx.instance.handleFileEvents([doomed, excluded])
    await until(() => ctx.read((store) => !store.documentByPath(doomed)))
    expect(ctx.read((store) => store.search('aardvark', null))).toEqual([])
    expect(ctx.read((store) => store.documentByPath(excluded)?.status)).toBe('excluded')
    expect(ctx.read((store) => store.stats().chunks)).toBe(0)
  })

  it('keeps the index when the file reappears within the grace period', async () => {
    const ctx = setup(80)
    const path = await indexed(ctx, 'flicker.txt', 'flickering pelican notes')
    rmSync(path)
    await ctx.instance.handleFileEvents([path])
    writeFileSync(path, 'flickering pelican notes')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(ctx.read((store) => store.documentByPath(path)?.status)).toBe('ready')
  })

  it('treats a rename with identical size and hash as a move without re-embedding', async () => {
    const ctx = setup(60_000)
    const oldPath = await indexed(ctx, 'before.txt', 'moved heron planning document')
    const before = ctx.read((store) => store.search('heron', null)[0]!)
    const embedCalls = ctx.fake.embeddingCalls.length
    const extractCalls = ctx.fake.extractionCalls.length
    const newPath = join(dir, 'sub', 'after.txt')
    mkdirSync(join(dir, 'sub'))
    renameSync(oldPath, newPath)

    await ctx.instance.handleFileEvents([oldPath, newPath])

    const after = ctx.read((store) => store.search('heron', null)[0]!)
    expect(after.path).toBe(newPath)
    expect(after.chunkId).toBe(before.chunkId)
    expect(ctx.read((store) => store.documentByPath(oldPath))).toBeNull()
    expect(ctx.read((store) => store.documentByPath(newPath)?.status)).toBe('ready')
    expect(ctx.fake.embeddingCalls.length).toBe(embedCalls)
    expect(ctx.fake.extractionCalls.length).toBe(extractCalls)
  })

  it('never tombstones when the drive itself is unreachable', async () => {
    if (process.platform !== 'win32') return
    const drive = 'Z:\\'
    let present = true
    try {
      statSync(drive)
    } catch {
      present = false
    }
    if (present) return
    const ctx = setup(10)
    const path = `${drive}unplugged\\report.txt`
    ctx.read((store) =>
      store.replaceDocument(path, {
        hash: 'h',
        mtimeMs: 1,
        sizeBytes: 5,
        chunks: [{ text: 'unplugged report', location: 'Chunk 1' }],
        embeddingModel: null,
        status: 'text-only',
      }),
    )
    await ctx.instance.handleFileEvents([path])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(ctx.read((store) => store.documentByPath(path)?.status)).toBe('text-only')
  })
})

describe('reconcileFolder', () => {
  it('enrolls new files, detects moves and forgets deleted files from a metadata listing', async () => {
    const ctx = setup()
    const root = join(dir, 'root')
    const kept = await indexed(ctx, 'kept.txt', 'kept flamingo text', root)
    const removed = await indexed(ctx, 'removed.txt', 'removed gecko text', root)
    const moved = await indexed(ctx, 'moved.txt', 'moved ibis text', root)
    const extractCalls = ctx.fake.extractionCalls.length

    rmSync(removed)
    const movedTo = join(root, 'archive', 'moved-renamed.txt')
    mkdirSync(join(root, 'archive'))
    renameSync(moved, movedTo)
    const added = join(root, 'added.txt')
    writeFileSync(added, 'added lemur text')

    const listing = new Map<string, { mtimeMs: number; sizeBytes: number }>()
    for (const path of [kept, movedTo, added]) {
      const stat = statSync(path)
      listing.set(path, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size })
    }
    const result = await ctx.instance.reconcileFolder(root, listing)

    expect(result).toEqual({ added: 1, changed: 0, moved: 1, removed: 1 })
    expect(ctx.read((store) => store.documentByPath(removed))).toBeNull()
    expect(ctx.read((store) => store.documentByPath(moved))).toBeNull()
    expect(ctx.read((store) => store.documentByPath(movedTo)?.status)).toBe('ready')
    await until(() => ctx.read((store) => store.documentByPath(added)?.status === 'ready'))
    // Only the genuinely new file was extracted; the unchanged and moved ones were not.
    expect(ctx.fake.extractionCalls.length).toBe(extractCalls + 1)
  })
})

describe('cost control', () => {
  it('stores numeric tables lexically without embedding them and records truncation', async () => {
    const ctx = setup()
    const path = join(dir, 'numbers.csv')
    writeFileSync(path, 'name,count\nlynx,2\nocelot,4')
    ctx.fake.skipEmbeddings = true
    ctx.instance.indexDiscoveredFile(path)
    await until(() => ctx.read((store) => store.documentByPath(path)?.status === 'ready'))
    expect(ctx.fake.embeddingCalls).toHaveLength(0)
    expect(ctx.read((store) => store.documentByPath(path)?.truncated)).toBe(true)
    expect(ctx.instance.getDocumentIndexProgress(path)).toMatchObject({
      state: 'ready',
      truncated: true,
    })
    const hits = (await ctx.instance.search('lynx')).hits
    expect(hits[0]).toMatchObject({ path, truncated: true })
  })
})
