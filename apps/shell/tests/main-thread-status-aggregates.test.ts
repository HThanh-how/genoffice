import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import {
  StatusAggregates,
  type AggregateFetcher,
} from '../src/main/document-memory/runtime/status-aggregates'
import {
  getDocumentIndexSnapshot,
  snapshotCache,
} from '../src/main/fork/document-index-snapshot-service'
import { seedDocuments } from './helpers/seed-documents'
import type { StatusRequest } from '../src/main/document-memory/runtime/index-status-types'

function fakeFetcher(answer: (request: StatusRequest) => unknown) {
  const calls: StatusRequest[] = []
  const fetcher: AggregateFetcher & { calls: StatusRequest[] } = {
    calls,
    call(request) {
      calls.push(request)
      return Promise.resolve(answer(request))
    },
    close() {},
  }
  return fetcher
}

describe('StatusAggregates', () => {
  it('returns at once, computes nothing on the calling thread and refreshes in the background', async () => {
    let clock = 0
    const fetcher = fakeFetcher(() => ({ docs: 7, chunks: 70, vectors: 70, errors: 0 }))
    const aggregates = new StatusAggregates(fetcher, {
      now: () => clock,
      minTtlMs: 1000,
      activeSpace: () => 'space',
    })
    // before the first answer: a neutral value, immediately
    expect(aggregates.stats()).toEqual({ docs: 0, chunks: 0, vectors: 0, errors: 0 })
    expect(fetcher.calls).toEqual([{ op: 'stats', space: 'space' }])
    await aggregates.settled()
    expect(aggregates.stats().docs).toBe(7)
    // fresh: served from memory, no new request
    aggregates.stats()
    aggregates.stats()
    expect(fetcher.calls).toHaveLength(1)
    // stale: the old value is returned at once and one request goes out, however often it is read meanwhile
    clock = 5_000
    expect(aggregates.stats().docs).toBe(7)
    aggregates.stats()
    aggregates.stats()
    expect(fetcher.calls).toHaveLength(2)
  })

  it('keeps the last value when the reader fails, and tries again after the minimum TTL', async () => {
    let clock = 0
    let fail = false
    const fetcher = fakeFetcher(() => {
      if (fail) throw new Error('reader down')
      return { total: 3, groups: [] }
    })
    const failing = {
      ...fetcher,
      call: async (r: StatusRequest) =>
        fail ? Promise.reject(new Error('down')) : fetcher.call(r),
    }
    const aggregates = new StatusAggregates(failing, { now: () => clock, minTtlMs: 1000 })
    aggregates.issues('*')
    await aggregates.settled()
    expect(aggregates.issues('*').total).toBe(3)
    fail = true
    clock = 10_000
    aggregates.issues('*')
    await aggregates.settled()
    expect(aggregates.issues('*').total).toBe(3)
    expect(fetcher.calls.length).toBe(1)
    clock = 12_000
    fail = false
    aggregates.issues('*')
    await aggregates.settled()
    expect(fetcher.calls.length).toBe(2)
  })

  it('answers an indexed-file search with the newest query only', async () => {
    const seen: string[] = []
    let finish: (() => void) | null = null
    const fetcher: AggregateFetcher = {
      call: (request) => {
        seen.push((request as { query: string }).query)
        return new Promise((resolve) => {
          finish = () => resolve([{ id: 1, path: '/a', name: request.op, status: 'ready' }])
        })
      },
      close() {},
    }
    const aggregates = new StatusAggregates(fetcher)
    const first = aggregates.searchIndexed('a')
    const second = aggregates.searchIndexed('ab')
    const third = aggregates.searchIndexed('abc')
    expect(await second).toEqual([]) // overtaken while waiting
    finish!()
    expect(await first).toHaveLength(1)
    await vi.waitFor(() => expect(seen).toEqual(['a', 'abc']))
    finish!()
    expect(await third).toHaveLength(1)
  })
})

describe('the dashboard snapshot does not read the documents table on the calling thread', () => {
  let dir: string
  let manager: DocumentMemoryManager | null = null
  let reader: IndexIssueReader | null = null
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-snapshot-thread-'))
    snapshotCache.clear()
  })
  afterEach(async () => {
    await manager?.closeAsync()
    reader?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves counts from the reader thread and never calls stats / folderChunkProgress / the issue summary itself', async () => {
    manager = new DocumentMemoryManager(dir, {
      dbDir: dir,
      initialEnabled: false,
      pollIntervalMs: 3_600_000,
    })
    seedDocuments(manager.store.rawDb, { docs: 120, junkEvery: 4, chunksPerDoc: 2 })
    reader = new IndexIssueReader(join(dir, 'document-memory.db'))
    const stats = vi.spyOn(manager.store, 'stats')
    const folder = vi.spyOn(manager.store, 'folderChunkProgress')
    const summary = vi.spyOn(reader, 'summary')
    const ctx = {
      getDocumentMemory: () => manager,
      getFolderScan: () => null,
      getIssueReader: () => reader!,
      getFolderCounts: () => ({ get: (_root: string, fetcher: () => never) => fetcher() }),
      dbPath: () => join(dir, 'document-memory.db'),
    }
    const cold = getDocumentIndexSnapshot(ctx, true)
    // the first snapshot has nothing to show yet and did not wait for (or compute) the numbers
    expect(cold.memory.documents).toBe(0)
    await manager.aggregates.settled()
    snapshotCache.clear()
    const warm = getDocumentIndexSnapshot(ctx, true)
    expect(warm.memory.documents).toBe(120)
    expect(warm.memory.chunks).toBe(240)
    expect(warm.activity.folderProgress?.totalFiles).toBe(120)
    expect(stats).not.toHaveBeenCalled()
    expect(folder).not.toHaveBeenCalled()
    expect(summary).not.toHaveBeenCalled()
  })
})
