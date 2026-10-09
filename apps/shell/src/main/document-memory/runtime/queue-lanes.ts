/**
 * One index process serves two lanes: reading (extraction, makes a file searchable) and vectors (embedding, makes it
 * semantic). The lane that has had the process for less time goes next, so neither waits behind the other for long:
 * reading used to wait for a free slot in the vector line, and on a slow computer the vectors of the first few hundred
 * files (hours of work) held back the reading of every file behind them.
 */
export type Lane = 'extract' | 'embed'

/** Longest the reading lane keeps the process while vectors are waiting for their turn (the lanes then share the time evenly). */
export const EXTRACT_SLICE_MS = 2_000
/** Same for the vector lane: a pass ends after the first batch that completes past this. */
export const EMBED_SLICE_MS = 4_000

export class QueueLanes {
  private readonly usedMs: Record<Lane, number> = { extract: 0, embed: 0 }
  private wanted: Record<Lane, boolean> = { extract: true, embed: true }
  private last: Lane = 'embed'

  /**
   * Which lane goes next; null when neither has work. The lane with less time goes first and a tie goes to the other lane
   * than last time. A lane that has nothing to do does not bank time: when its work returns it gets an even share, not a monopoly.
   */
  next(canExtract: boolean, canEmbed: boolean): Lane | null {
    this.wanted = { extract: canExtract, embed: canEmbed }
    if (!canExtract) this.usedMs.extract = Math.max(this.usedMs.extract, this.usedMs.embed)
    if (!canEmbed) this.usedMs.embed = Math.max(this.usedMs.embed, this.usedMs.extract)
    let lane: Lane | null = null
    if (canExtract && canEmbed) {
      const diff = this.usedMs.extract - this.usedMs.embed
      lane =
        diff < 0 ? 'extract' : diff > 0 ? 'embed' : this.last === 'extract' ? 'embed' : 'extract'
    } else if (canExtract) lane = 'extract'
    else if (canEmbed) lane = 'embed'
    if (lane) this.last = lane
    return lane
  }

  /** The lane ran for `ms`; time the other lane spent with nothing to do is not owed to it. */
  add(lane: Lane, ms: number): void {
    const other: Lane = lane === 'extract' ? 'embed' : 'extract'
    this.usedMs[lane] += Math.max(0, ms)
    if (!this.wanted[other]) this.usedMs[other] = Math.max(this.usedMs[other], this.usedMs[lane])
  }
}
