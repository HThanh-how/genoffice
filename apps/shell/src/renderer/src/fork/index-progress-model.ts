import type { HomeIndexingActivity } from '../../../shared/home-api'
import { EtaTracker, type EtaEstimate } from '../indexing-activity-model'

export interface IndexProgressReading {
  eta: EtaEstimate | null
  filesPerMinute: number | null
  passagesPerMinute: number | null
  quiet: boolean
}

/** File completion and passage completion are separate signals: a large file can take minutes. */
export class IndexProgressTracker {
  private eta = new EtaTracker()
  private identity = ''
  private samples: { at: number; files: number; passages: number; extracted: number }[] = []
  private changedAt = 0

  record(at: number, activity: HomeIndexingActivity | null, paused: boolean): IndexProgressReading {
    const progress = activity?.folderProgress
    const active =
      !!activity?.memory.enabled &&
      !paused &&
      !activity.folder?.running &&
      activity.memory.modelState === 'ready' &&
      activity.memory.pending > 0 &&
      !!progress
    const scope = activity?.progressScope === 'library' ? 'library' : (activity?.folder?.root ?? '')
    const identity = active ? `${scope}:${progress!.totalFiles}` : ''
    if (!active || identity !== this.identity) {
      this.eta.reset()
      this.samples = []
      this.changedAt = at
      this.identity = identity
    }
    if (!active || !progress)
      return { eta: null, filesPerMinute: null, passagesPerMinute: null, quiet: false }
    // readyFiles includes empty files; adding emptyFiles would count them twice.
    const current = {
      at,
      files: progress.readyFiles + progress.errorFiles,
      passages: progress.completedChunks,
      extracted: progress.totalChunks,
    }
    const previous = this.samples.at(-1)
    if (
      previous &&
      (current.files < previous.files || current.passages < previous.passages || at < previous.at)
    ) {
      this.samples = []
      this.eta.reset()
      this.changedAt = at
    }
    if (
      !previous ||
      current.files !== previous.files ||
      current.passages !== previous.passages ||
      current.extracted !== previous.extracted
    )
      this.changedAt = at
    this.samples.push(current)
    while (this.samples.length > 2 && this.samples[1]!.at < at - 60_000) this.samples.shift()
    this.eta.record(at, current.files, progress.totalFiles)
    const first = this.samples[0]!
    const span = at - first.at
    const quiet = at - this.changedAt >= 60_000
    const speed = (delta: number) =>
      span >= 10_000 ? Math.max(0, Math.round((delta * 60_000) / span)) : null
    return {
      eta: quiet ? null : this.eta.estimate(),
      quiet,
      filesPerMinute: speed(current.files - first.files),
      passagesPerMinute: speed(current.passages - first.passages),
    }
  }
}
