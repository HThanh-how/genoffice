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

  it('interleaved requests for the same dbPath coalesce compatible options without overwriting or crossing results', async () => {
    const dbPath = join(tempDir, 'document-memory.db')
    writeFileSync(dbPath, Buffer.alloc(10_000))

    const annPathA = join(tempDir, 'spaceA.usearch')
    const annPathB = join(tempDir, 'spaceB.usearch')
    writeFileSync(annPathA, Buffer.alloc(20_000))
    writeFileSync(annPathB, Buffer.alloc(50_000))

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
        }, 15)
        return workerLike as any
      },
    })

    const optA = { dbPath, annIndexesMeta: [{ space_id: 'spaceA', file_path: annPathA }] }
    const optB = { dbPath, annIndexesMeta: [{ space_id: 'spaceB', file_path: annPathB }] }

    // Dispatch A1, then B1, then A2, then B2
    const pA1 = runner.run(optA)
    const pB1 = runner.run(optB)
    const pA2 = runner.run(optA)
    const pB2 = runner.run(optB)

    const [resA1, resB1, resA2, resB2] = await Promise.all([pA1, pB1, pA2, pB2])

    // A1 and A2 shared the same result; B1 and B2 shared the same result
    expect(resA1).toBe(resA2)
    expect(resB1).toBe(resB2)
    expect(resA1.annSizeBytes).toBe(20_000)
    expect(resB1.annSizeBytes).toBe(50_000)
    expect(executedOptions).toHaveLength(2)
  })

  it('bounds pending queue work and rejects requests beyond MAX_CONCURRENT_PENDING_PATHS', async () => {
    const dbPathBase = join(tempDir, 'db-')

    runner = new StorageAccountingRunner({
      workerFactory: () => {
        const listeners: Record<string, ((val: any) => void)[]> = {}
        const workerLike = {
          on(event: string, fn: (val: any) => void) {
            listeners[event] = listeners[event] || []
            listeners[event].push(fn)
            return workerLike
          },
          terminate: () => Promise.resolve(0),
        }
        // Deliberately slow worker so queue accumulates
        setTimeout(() => {
          listeners['message']?.forEach((fn) =>
            fn({
              ok: true,
              report: {
                databaseBytes: 1000,
                dbSizeBytes: 1000,
                walSizeBytes: 0,
                shmSizeBytes: 0,
                sidecarSizeBytes: 0,
                annSizeBytes: 0,
                ocrSizeBytes: 0,
                tempSizeBytes: 0,
                backupSizeBytes: 0,
                protectedBytes: 0,
                totalManagedBytes: 1000,
                totalTrackedBytes: 1000,
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
              },
            }),
          )
        }, 50)
        return workerLike as any
      },
    })

    const promises: Promise<StorageAccountingReport>[] = []
    for (let i = 0; i < 32; i++) {
      const p = `${dbPathBase}${i}.db`
      writeFileSync(p, Buffer.alloc(100))
      promises.push(runner.run({ dbPath: p }))
    }

    // 33rd request exceeds MAX_CONCURRENT_PENDING_PATHS (32)
    const pOverflow = `${dbPathBase}overflow.db`
    writeFileSync(pOverflow, Buffer.alloc(100))
    const overflowReport = await runner.run({ dbPath: pOverflow })

    expect(overflowReport.isDegraded).toBe(true)
    expect(overflowReport.measurementErrors[0]?.error).toContain(
      'Storage accounting queue capacity reached',
    )

    await Promise.all(promises)
  })

  it('settles all pending queued promises cleanly upon runner disposal', async () => {
    const dbPathBase = join(tempDir, 'db-dispose-')

    runner = new StorageAccountingRunner({
      workerFactory: () => {
        const workerLike = {
          on() {
            return workerLike
          },
          terminate: () => Promise.resolve(0),
        }
        // Never completes on its own to test disposal abort
        return workerLike as any
      },
    })

    const p1 = `${dbPathBase}1.db`
    const p2 = `${dbPathBase}2.db`
    writeFileSync(p1, Buffer.alloc(100))
    writeFileSync(p2, Buffer.alloc(100))

    const promise1 = runner.run({ dbPath: p1 })
    const promise2 = runner.run({ dbPath: p2 })

    // Runner disposed while 1 is active and 2 is pending in queue
    runner.dispose()

    const [res1, res2] = await Promise.all([promise1, promise2])

    expect(res1.isDegraded).toBe(true)
    expect(res1.measurementErrors[0]?.error).toContain('Accounting runner disposed')
    expect(res2.isDegraded).toBe(true)
    expect(res2.measurementErrors[0]?.error).toContain('Accounting runner disposed')
  })
})
