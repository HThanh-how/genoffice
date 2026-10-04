import { describe, expect, it } from 'vitest'
import type { HomeIndexingActivity } from '../src/shared/home-api'
import { IndexProgressTracker } from '../src/renderer/src/fork/index-progress-model'

function activity(files = 10, passages = 100): HomeIndexingActivity {
  return {
    folder: null,
    memory: { enabled: true, modelState: 'ready', pending: 90, errors: 0 },
    folderProgress: {
      totalFiles: 100,
      readyFiles: files,
      emptyFiles: 3,
      pendingFiles: 90,
      errorFiles: 0,
      completedChunks: passages,
      totalChunks: 1000,
      percent: 10,
    },
  }
}
describe('IndexProgressTracker', () => {
  it('shows progress inside a large file without pretending it finished', () => {
    const tracker = new IndexProgressTracker()
    tracker.record(0, activity(), false)
    expect(tracker.record(10_000, activity(10, 200), false)).toMatchObject({
      filesPerMinute: 0,
      passagesPerMinute: 600,
      quiet: false,
      eta: null,
    })
  })
  it('clears estimates during scans, pause, missing reads, and model downloads', () => {
    for (const phase of ['scan', 'pause', 'missing', 'model']) {
      const tracker = new IndexProgressTracker()
      for (let i = 0; i < 5; i++) tracker.record(i * 10_000, activity(10 + i * 5), false)
      expect(tracker.record(50_000, activity(35), false).eta).not.toBeNull()
      const next = activity(35)
      if (phase === 'model') next.memory.modelState = 'downloading'
      if (phase === 'scan') next.folder = { running: true } as HomeIndexingActivity['folder']
      expect(
        tracker.record(60_000, phase === 'missing' ? null : next, phase === 'pause').eta,
      ).toBeNull()
    }
  })
  it('reports a quiet pipeline without claiming a failure, then recovers', () => {
    const tracker = new IndexProgressTracker()
    tracker.record(0, activity(), false)
    expect(tracker.record(60_000, activity(), false).quiet).toBe(true)
    expect(tracker.record(62_000, activity(10, 110), false).quiet).toBe(false)
  })
})
