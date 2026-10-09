import { MAX_PENDING_EMBED_DOCUMENTS } from './extraction-coordinator'

/**
 * Who may be read while the vector line is full. The vector line holds extracted text in memory, so it is bounded; a file
 * that only lacks vectors (`textOnly`: its text is already indexed) waits for room in it, but a file never read is always
 * read - searchable text comes first, whatever the vectors are doing. A file read while the line was full keeps its text in
 * the database and parks in `waiting` (memory only; the database still says text-only), to re-enter the line as room opens.
 */
export class VectorGate {
  /** queued paths that only lack vectors; always a subset of the line */
  readonly textOnly = new Set<string>()
  private readonly waiting = new Set<string>()

  constructor(
    private readonly vectorLine: () => number,
    private readonly max = MAX_PENDING_EMBED_DOCUMENTS,
  ) {}

  get parked(): number {
    return this.waiting.size
  }

  isParked(path: string): boolean {
    return this.waiting.has(path)
  }

  room(): boolean {
    return this.vectorLine() < this.max
  }

  /** Something in a line of `length` files can be read now (a file somebody asked for now is always readable). Cheap: `urgent` is small. */
  extractable(length: number, urgent: ReadonlySet<string>): boolean {
    if (length === 0) return false
    if (length > this.textOnly.size || this.room()) return true
    for (const path of urgent) if (this.textOnly.has(path)) return true
    return false
  }

  /** Paths to leave out of the next pick (undefined = none): files that only lack vectors, unless someone asked for them now. */
  skip(urgent: ReadonlySet<string>): ((path: string) => boolean) | undefined {
    return this.room() ? undefined : (path) => this.textOnly.has(path) && !urgent.has(path)
  }

  /** A path entered the line with this status. */
  queued(path: string, status: string): void {
    this.waiting.delete(path)
    if (status === 'text-only') this.textOnly.add(path)
    else this.textOnly.delete(path)
  }

  /** The path left the line because it is being read: tells whether it only lacked vectors. */
  taken(path: string): boolean {
    return this.textOnly.delete(path)
  }

  park(path: string): void {
    this.waiting.add(path)
  }

  /** The path is dropped from the line (and from the wait). */
  forget(path: string): void {
    this.textOnly.delete(path)
    this.waiting.delete(path)
  }

  /** Parked paths to bring back into the line now, as many as the vector line has room for. */
  release(): string[] {
    const out: string[] = []
    let room = this.max - this.vectorLine() - this.textOnly.size
    for (const path of this.waiting) {
      if (room-- <= 0) break
      out.push(path)
    }
    for (const path of out) this.waiting.delete(path)
    return out
  }

  clear(): void {
    this.textOnly.clear()
    this.waiting.clear()
  }
}
