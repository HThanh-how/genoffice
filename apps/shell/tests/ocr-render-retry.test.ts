import { describe, expect, it, vi } from 'vitest'
import { executeOcrRenderGated } from '../src/main/document-memory/runtime/ocr-write-budget'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import type { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import type { StorageBudgetCoordinator } from '../src/main/document-memory/runtime/storage-budget-coordinator'
import { createStorageBudget } from '../src/main/document-memory/storage-budget'

function setup() {
  let ready = false
  const budgetCoord = {
    isWriteReady: () => ready,
    recover: vi.fn(async () => false),
  }
  const budget = createStorageBudget()
  const admission = new StorageAdmissionController()
  const askWorker = vi.fn().mockResolvedValue({ result: { ok: true, pages: [] } })
  const snapshot = { databaseBytes: 1024, totalManagedBytes: 1024, isDegraded: false }
  return {
    setReady: () => {
      ready = true
    },
    budgetCoord,
    snapshot,
    askWorker,
    admission,
    params: {
      admission,
      budgetCoord: budgetCoord as unknown as StorageBudgetCoordinator,
      maintScheduler: {
        budget,
        checkStorageBudget: () => snapshot,
      } as unknown as MaintenanceScheduler,
      dbDir: '',
      path: 'scan.pdf',
      request: { done: [], count: 1, maxPages: 2 },
      askWorker,
    },
  }
}

describe('OCR render infrastructure deferral', () => {
  it('recovers the budget handshake before admitting a render', async () => {
    const s = setup()
    s.budgetCoord.recover.mockImplementation(async () => {
      s.setReady()
      return true
    })
    expect(await executeOcrRenderGated(s.params)).toMatchObject({ ok: true })
    expect(s.budgetCoord.recover).toHaveBeenCalledOnce()
    expect(s.askWorker).toHaveBeenCalledOnce()
    expect(s.admission.listReservations()).toHaveLength(0)
  })

  it('defers without rendering if the handshake is still pending', async () => {
    const s = setup()
    expect(await executeOcrRenderGated(s.params)).toMatchObject({ ok: false, retryable: true })
    expect(s.askWorker).not.toHaveBeenCalled()
    expect(s.admission.listReservations()).toHaveLength(0)
  })

  it('defers quota refusal rather than blaming the PDF', async () => {
    const s = setup()
    s.setReady()
    s.snapshot.databaseBytes = s.snapshot.totalManagedBytes = 20 * 1024 ** 3
    expect(await executeOcrRenderGated(s.params)).toMatchObject({ ok: false, retryable: true })
    expect(s.askWorker).not.toHaveBeenCalled()
  })

  it('distinguishes a worker failure from a corrupt PDF', async () => {
    const s = setup()
    s.setReady()
    s.askWorker.mockResolvedValueOnce({ error: 'Worker was restarted' })
    expect(await executeOcrRenderGated(s.params)).toMatchObject({ ok: false, retryable: true })
    s.askWorker.mockResolvedValueOnce({
      result: { ok: false, code: 'corrupt', message: 'Invalid PDF' },
    })
    expect(await executeOcrRenderGated(s.params)).toEqual({
      ok: false,
      code: 'corrupt',
      message: 'Invalid PDF',
    })
  })
})
