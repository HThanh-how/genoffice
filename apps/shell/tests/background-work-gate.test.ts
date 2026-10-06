import { describe, expect, it } from 'vitest'
import {
  BackgroundWorkGate,
  BackgroundWorkPriority,
  classifyPriority,
  classifyRequestType,
  getPriorityForType,
} from '../src/main/document-memory/background-work-gate'

describe('BackgroundWorkGate', () => {
  describe('Classification & Priority Mapping', () => {
    it('classifies priorities correctly', () => {
      expect(classifyPriority(BackgroundWorkPriority.P0_INTERACTIVE)).toBe('interactive')
      expect(classifyPriority(BackgroundWorkPriority.P1_USER_INITIATED)).toBe('index')
      expect(classifyPriority(BackgroundWorkPriority.P2_NORMAL_INDEXING)).toBe('index')
      expect(classifyPriority(BackgroundWorkPriority.P3_MIGRATION)).toBe('maintenance')
      expect(classifyPriority(BackgroundWorkPriority.P4_HOUSEKEEPING)).toBe('maintenance')
    })

    it('classifies request types correctly', () => {
      expect(classifyRequestType('search')).toBe('interactive')
      expect(classifyRequestType('search-lexical')).toBe('interactive')
      expect(classifyRequestType('read-now')).toBe('interactive')
      expect(classifyRequestType('query-embedding')).toBe('interactive')

      expect(classifyRequestType('extract')).toBe('index')
      expect(classifyRequestType('passage-embedding')).toBe('index')
      expect(classifyRequestType('user-index')).toBe('index')

      expect(classifyRequestType('fts-maintenance-step')).toBe('maintenance')
      expect(classifyRequestType('gc')).toBe('maintenance')
      expect(classifyRequestType('vacuum')).toBe('maintenance')
      expect(classifyRequestType('chunk-upgrade')).toBe('maintenance')
      expect(classifyRequestType('embedding-migration')).toBe('maintenance')
      expect(classifyRequestType('ann-rebuild')).toBe('maintenance')
    })

    it('maps request types to correct priority levels', () => {
      expect(getPriorityForType('search')).toBe(BackgroundWorkPriority.P0_INTERACTIVE)
      expect(getPriorityForType('user-index')).toBe(BackgroundWorkPriority.P1_USER_INITIATED)
      expect(getPriorityForType('extract')).toBe(BackgroundWorkPriority.P2_NORMAL_INDEXING)
      expect(getPriorityForType('chunk-upgrade')).toBe(BackgroundWorkPriority.P3_MIGRATION)
      expect(getPriorityForType('fts-maintenance-step')).toBe(BackgroundWorkPriority.P4_HOUSEKEEPING)
    })
  })

  describe('canRun Under Normal vs Paused States', () => {
    it('allows all priorities when indexing is running (unpaused)', () => {
      const gate = new BackgroundWorkGate({
        pauseCheck: () => false,
        autoSubscribePolicy: false,
      })

      expect(gate.canRun(BackgroundWorkPriority.P0_INTERACTIVE)).toBe(true)
      expect(gate.canRun(BackgroundWorkPriority.P1_USER_INITIATED)).toBe(true)
      expect(gate.canRun(BackgroundWorkPriority.P2_NORMAL_INDEXING)).toBe(true)
      expect(gate.canRun(BackgroundWorkPriority.P3_MIGRATION)).toBe(true)
      expect(gate.canRun(BackgroundWorkPriority.P4_HOUSEKEEPING)).toBe(true)

      expect(gate.canRun('search')).toBe(true)
      expect(gate.canRun('extract')).toBe(true)
      expect(gate.canRun('fts-maintenance-step')).toBe(true)

      gate.dispose()
    })

    it('allows only P0 Interactive and blocks P1-P4 when indexing is paused', () => {
      const gate = new BackgroundWorkGate({
        pauseCheck: () => true,
        autoSubscribePolicy: false,
      })

      // P0 Interactive is retained during pause
      expect(gate.canRun(BackgroundWorkPriority.P0_INTERACTIVE)).toBe(true)
      expect(gate.canRun('interactive')).toBe(true)
      expect(gate.canRun('search')).toBe(true)
      expect(gate.canRun('read-now')).toBe(true)

      // P1-P4 Index & Maintenance are blocked during pause
      expect(gate.canRun(BackgroundWorkPriority.P1_USER_INITIATED)).toBe(false)
      expect(gate.canRun(BackgroundWorkPriority.P2_NORMAL_INDEXING)).toBe(false)
      expect(gate.canRun(BackgroundWorkPriority.P3_MIGRATION)).toBe(false)
      expect(gate.canRun(BackgroundWorkPriority.P4_HOUSEKEEPING)).toBe(false)

      expect(gate.canRun('index')).toBe(false)
      expect(gate.canRun('maintenance')).toBe(false)
      expect(gate.canRun('extract')).toBe(false)
      expect(gate.canRun('fts-maintenance-step')).toBe(false)
      expect(gate.canRun('gc')).toBe(false)

      gate.dispose()
    })
  })

  describe('Priority-Based Task Execution', () => {
    it('executes tasks in priority order (P0 > P1 > P2 > P3 > P4)', async () => {
      const gate = new BackgroundWorkGate({
        pauseCheck: () => false,
        autoSubscribePolicy: false,
        concurrency: 1, // Serial execution to verify priority order
      })

      const executionOrder: string[] = []

      // Enqueue lower priority tasks first
      const p4Promise = gate.enqueue(BackgroundWorkPriority.P4_HOUSEKEEPING, async () => {
        executionOrder.push('P4')
        return 'P4'
      })

      const p3Promise = gate.enqueue(BackgroundWorkPriority.P3_MIGRATION, async () => {
        executionOrder.push('P3')
        return 'P3'
      })

      const p2Promise = gate.enqueue(BackgroundWorkPriority.P2_NORMAL_INDEXING, async () => {
        executionOrder.push('P2')
        return 'P2'
      })

      const p1Promise = gate.enqueue(BackgroundWorkPriority.P1_USER_INITIATED, async () => {
        executionOrder.push('P1')
        return 'P1'
      })

      const p0Promise = gate.enqueue(BackgroundWorkPriority.P0_INTERACTIVE, async () => {
        executionOrder.push('P0')
        return 'P0'
      })

      await Promise.all([p0Promise, p1Promise, p2Promise, p3Promise, p4Promise])

      // P4 started first because queue was empty when it was enqueued,
      // but while P4 ran, P3, P2, P1, P0 were queued. Once P4 finished,
      // the remaining must execute in priority order: P0, P1, P2, P3!
      expect(executionOrder[0]).toBe('P4')
      expect(executionOrder.slice(1)).toEqual(['P0', 'P1', 'P2', 'P3'])

      gate.dispose()
    })
  })

  describe('Pause Cancellation & Rejection', () => {
    it('immediately rejects new background tasks when paused, but allows interactive', async () => {
      const gate = new BackgroundWorkGate({
        pauseCheck: () => true,
        autoSubscribePolicy: false,
      })

      // Background task should reject
      await expect(
        gate.enqueue(BackgroundWorkPriority.P2_NORMAL_INDEXING, async () => 'done'),
      ).rejects.toThrow('Work rejected: indexing is paused')

      // Maintenance task should reject
      await expect(
        gate.enqueue(BackgroundWorkPriority.P4_HOUSEKEEPING, async () => 'done'),
      ).rejects.toThrow('Work rejected: indexing is paused')

      // Interactive task should succeed
      const interactiveResult = await gate.enqueue(
        BackgroundWorkPriority.P0_INTERACTIVE,
        async () => 'search-result',
      )
      expect(interactiveResult).toBe('search-result')

      gate.dispose()
    })

    it('cancels pending background tasks on pause while preserving interactive tasks', async () => {
      let isPaused = false
      const gate = new BackgroundWorkGate({
        pauseCheck: () => isPaused,
        autoSubscribePolicy: false,
        concurrency: 1,
      })

      // Block concurrency with an in-flight blocker task
      let unblock: () => void = () => {}
      const blockerPromise = new Promise<void>((resolve) => {
        unblock = resolve
      })
      const initialTask = gate.enqueue(BackgroundWorkPriority.P0_INTERACTIVE, async () => {
        await blockerPromise
        return 'initial'
      })

      // Queue background tasks while blocker is running
      const bgTask1 = gate.enqueue(BackgroundWorkPriority.P2_NORMAL_INDEXING, async () => 'bg1')
      const bgTask2 = gate.enqueue(BackgroundWorkPriority.P4_HOUSEKEEPING, async () => 'bg2')
      const interactiveTask = gate.enqueue(BackgroundWorkPriority.P0_INTERACTIVE, async () => 'ui')

      expect(gate.getPendingCount()).toBe(3)

      // Now pause occurs
      isPaused = true
      gate.handlePaused()

      // Pending background tasks must be cancelled
      await expect(bgTask1).rejects.toThrow('Work cancelled: indexing paused')
      await expect(bgTask2).rejects.toThrow('Work cancelled: indexing paused')

      // Unblock initial task
      unblock()
      await initialTask

      // Interactive task must still complete successfully
      const result = await interactiveTask
      expect(result).toBe('ui')

      gate.dispose()
    })

    it('allows cancelling specific tasks by ID', async () => {
      const gate = new BackgroundWorkGate({
        pauseCheck: () => false,
        autoSubscribePolicy: false,
        concurrency: 1,
      })

      let releaseBlocker: () => void = () => {}
      const blocker = new Promise<void>((r) => {
        releaseBlocker = r
      })
      void gate.enqueue(BackgroundWorkPriority.P0_INTERACTIVE, async () => blocker)

      const queuedTask = gate.enqueue(
        BackgroundWorkPriority.P2_NORMAL_INDEXING,
        async () => 'will-cancel',
        { id: 'target-task-1' },
      )

      expect(gate.cancelTask('target-task-1', 'Cancelled by user')).toBe(true)
      await expect(queuedTask).rejects.toThrow('Cancelled by user')

      releaseBlocker()
      gate.dispose()
    })
  })
})
