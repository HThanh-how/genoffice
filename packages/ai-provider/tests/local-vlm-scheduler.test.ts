import { describe, expect, it } from 'vitest'
import {
  InferencePriority,
  LocalVlmInferenceScheduler,
} from '../src/local-vlm-scheduler'

describe('LocalVlmInferenceScheduler (Issue 7.4 Priority Queue & Backpressure)', () => {
  it('preempts queue: interactive user chat runs ahead of background OCR tasks', async () => {
    const scheduler = new LocalVlmInferenceScheduler({ maxConcurrency: 1 })
    const executionOrder: string[] = []

    // 1. Block the single execution slot with an in-flight blocker task
    let releaseBlocker: () => void
    const blockerPromise = new Promise<void>((r) => {
      releaseBlocker = r
    })
    const blockerTask = scheduler.schedule(InferencePriority.BACKGROUND_OCR, async () => {
      await blockerPromise
      executionOrder.push('blocker')
      return 'blocker-done'
    })

    // 2. Queue a background OCR task
    const ocrTask = scheduler.schedule(InferencePriority.BACKGROUND_OCR, async () => {
      executionOrder.push('ocr')
      return 'ocr-done'
    })

    // 3. Queue a foreground doc task
    const docTask = scheduler.schedule(InferencePriority.FOREGROUND_DOC, async () => {
      executionOrder.push('doc')
      return 'doc-done'
    })

    // 4. Queue an interactive user chat task
    const chatTask = scheduler.schedule(InferencePriority.INTERACTIVE, async () => {
      executionOrder.push('chat')
      return 'chat-done'
    })

    // Check stats: 1 running, 3 queued
    const statsBefore = scheduler.getStats()
    expect(statsBefore.running).toBe(1)
    expect(statsBefore.queued).toBe(3)
    expect(statsBefore.queueByPriority.interactive).toBe(1)
    expect(statsBefore.queueByPriority.foregroundDoc).toBe(1)
    expect(statsBefore.queueByPriority.backgroundOcr).toBe(1)

    // Unblock the slot
    releaseBlocker!()

    const results = await Promise.all([blockerTask, ocrTask, docTask, chatTask])
    expect(results).toEqual(['blocker-done', 'ocr-done', 'doc-done', 'chat-done'])

    // The order of execution after blocker finishes must be:
    // 'chat' (priority 1) -> 'doc' (priority 2) -> 'ocr' (priority 3)
    expect(executionOrder).toEqual(['blocker', 'chat', 'doc', 'ocr'])
  })

  it('removes queued tasks immediately when AbortSignal is aborted without executing them', async () => {
    const scheduler = new LocalVlmInferenceScheduler({ maxConcurrency: 1 })

    // Block runner
    let releaseBlocker: () => void
    const blockerPromise = new Promise<void>((r) => {
      releaseBlocker = r
    })
    void scheduler.schedule(InferencePriority.INTERACTIVE, () => blockerPromise)

    const abortCtrl = new AbortController()
    let executed = false

    const queuedTask = scheduler.schedule(
      InferencePriority.BACKGROUND_OCR,
      async () => {
        executed = true
        return 'done'
      },
      { signal: abortCtrl.signal },
    )

    expect(scheduler.getStats().queued).toBe(1)

    // Abort while waiting in queue
    abortCtrl.abort()

    await expect(queuedTask).rejects.toThrow('Inference task aborted while in scheduler queue')
    expect(scheduler.getStats().queued).toBe(0)

    releaseBlocker!()
    expect(executed).toBe(false)
  })

  it('enforces backpressure and rejects low-priority background tasks when queue is full', async () => {
    const scheduler = new LocalVlmInferenceScheduler({ maxConcurrency: 1, maxQueueSize: 2 })

    // Fill concurrency
    let release: () => void
    const blocker = new Promise<void>((r) => {
      release = r
    })
    void scheduler.schedule(InferencePriority.INTERACTIVE, () => blocker)

    // Fill queue slots (2 slots)
    void scheduler.schedule(InferencePriority.BACKGROUND_OCR, () => blocker)
    void scheduler.schedule(InferencePriority.BACKGROUND_OCR, () => blocker)

    expect(scheduler.getStats().queued).toBe(2)

    // 3rd background task should be rejected with backpressure error
    await expect(
      scheduler.schedule(InferencePriority.BACKGROUND_OCR, async () => 'overflow'),
    ).rejects.toThrow('Local VLM inference queue is saturated')

    release!()
  })
})
