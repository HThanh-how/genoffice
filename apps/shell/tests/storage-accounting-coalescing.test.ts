import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageAccountingRunner } from '../src/main/document-memory/runtime/storage-accounting-runner'
import type {
  StorageAccountingOptions,
  StorageAccountingReport,
} from '../src/main/document-memory/runtime/storage-accounting'

describe('P1-2: Storage accounting runner coalescing compatibility', () => {
  let tempDir: string
  let runner: StorageAccountingRunner

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dm-accounting-coalesce-'))
  })

  afterEach(() => {
    runner?.dispose()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('does not coalesce requests for the same dbPath when annIndexesMeta differ despite having equal length', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    writeFileSync(dbPath, Buffer.alloc(10_000))

    const annPathA = join(tempDir, 'spaceA.usearch')
    const annPathB = join(tempDir, 'spaceB.usearch')
    writeFileSync(annPathA, Buffer.alloc(20_000))
    writeFileSync(annPathB, Buffer.alloc(50_000))

    const executedOptions: StorageAccountingOptions[] = []

    // Custom fake worker factory that captures the exact options passed to each run
    runner = new StorageAccountingRunner({
      workerFactory: (_script, data) => {
        executedOptions.push(data)
        const listeners: Record<string, ((val: any) => void)[]> = {}
        const workerLike = {
          on(event: string, fn: (val: any) => void) {
            listeners[event] = listeners[event] || []
            listeners[event].push(fn)
            return workerLike
          },
          terminate: () => Promise.resolve(0),
        }
        // Respond asynchronously with the file size corresponding to the ANN file in options
        setTimeout(() => {
          const annBytes = data.annIndexesMeta?.[0]?.file_path === annPathA ? 20_000 : 50_000
          const report: Partial<StorageAccountingReport> = {
            databaseBytes: 10_000,
            dbSizeBytes: 10_000,
            walSizeBytes: 0,
            shmSizeBytes: 0,
            sidecarSizeBytes: 0,
            annSizeBytes: annBytes,
            ocrSizeBytes: 0,
            tempSizeBytes: 0,
            backupSizeBytes: 0,
            protectedBytes: 0,
            totalManagedBytes: 10_000 + annBytes,
            totalTrackedBytes: 10_000 + annBytes,
            reclaimableBytes: 0,
            reusableFreelistBytes: 0,
            modelWeightsBytes: 0,
            breakdown: {
              activeDbBytes: 10_000,
              walBytes: 0,
              shmBytes: 0,
              annBytes,
              ocrExternalBytes: 0,
              tempBytes: 0,
              backupBytes: 0,
              protectedBackupBytes: 0,
              reusableFreelistBytes: 0,
              modelWeightsBytes: 0,
            },
            annFiles: [{ path: data.annIndexesMeta?.[0]?.file_path || '', sizeBytes: annBytes }],
            backupFiles: [],
            tempFiles: [],
            ocrFiles: [],
            measurementErrors: [],
            isDegraded: false,
            timestamp: Date.now(),
            lastAttemptTimestamp: Date.now(),
          }
          listeners['message']?.forEach((fn) => fn({ ok: true, report }))
        }, 10)
        return workerLike as any
      },
    })

    // Request A with ANN meta spaceA
    const reqA = runner.run({
      dbPath,
      annIndexesMeta: [{ space_id: 'spaceA', file_path: annPathA }],
    })

    // Request B with ANN meta spaceB (same array length = 1, same dbPath, different space_id and file_path)
    const reqB = runner.run({
      dbPath,
      annIndexesMeta: [{ space_id: 'spaceB', file_path: annPathB }],
    })

    const [resA, resB] = await Promise.all([reqA, reqB])

    // They must NOT have been coalesced: two distinct worker tasks must have executed!
    expect(executedOptions).toHaveLength(2)
    expect(executedOptions[0]?.annIndexesMeta?.[0]?.space_id).toBe('spaceA')
    expect(executedOptions[1]?.annIndexesMeta?.[0]?.space_id).toBe('spaceB')

    // Reports must reflect the distinct measurements truthfully
    expect(resA.annSizeBytes).toBe(20_000)
    expect(resB.annSizeBytes).toBe(50_000)
  })

  it('safely coalesces requests when all options and annIndexesMeta content are identical', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    writeFileSync(dbPath, Buffer.alloc(10_000))
    const annPathA = join(tempDir, 'spaceA.usearch')
    writeFileSync(annPathA, Buffer.alloc(20_000))

    const executedOptions: StorageAccountingOptions[] = []

    runner = new StorageAccountingRunner({
      workerFactory: (_script, data) => {
        executedOptions.push(data)
        const listeners: Record<string, ((val: any) => void)[]> = {}
        const workerLike = {
          on(event: string, fn: (val: any) => void) {
            listeners[event] = listeners[event] || []
            listeners[event].push(fn)
            return workerLike
          },
          terminate: () => Promise.resolve(0),
        }
        setTimeout(() => {
          const report: Partial<StorageAccountingReport> = {
            databaseBytes: 10_000,
            dbSizeBytes: 10_000,
            walSizeBytes: 0,
            shmSizeBytes: 0,
            sidecarSizeBytes: 0,
            annSizeBytes: 20_000,
            ocrSizeBytes: 0,
            tempSizeBytes: 0,
            backupSizeBytes: 0,
            protectedBytes: 0,
            totalManagedBytes: 30_000,
            totalTrackedBytes: 30_000,
            reclaimableBytes: 0,
            reusableFreelistBytes: 0,
            modelWeightsBytes: 0,
            breakdown: {} as any,
            annFiles: [],
            backupFiles: [],
            tempFiles: [],
            ocrFiles: [],
            measurementErrors: [],
            isDegraded: false,
            timestamp: Date.now(),
            lastAttemptTimestamp: Date.now(),
          }
          listeners['message']?.forEach((fn) => fn({ ok: true, report }))
        }, 10)
        return workerLike as any
      },
    })

    const opt = {
      dbPath,
      annIndexesMeta: [{ space_id: 'spaceA', file_path: annPathA }],
    }

    const [res1, res2] = await Promise.all([runner.run(opt), runner.run(opt)])

    // Identical options: safely coalesced into 1 execution
    expect(executedOptions).toHaveLength(1)
    expect(res1).toBe(res2)
  })
})
