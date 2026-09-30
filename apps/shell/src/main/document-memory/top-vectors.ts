interface ScoredVector {
  id: number
  score: number
}

/** Keep only the best candidates while scanning, without retaining the corpus in RAM. */
export function topVectors<T extends ScoredVector>(rows: Iterable<T>, limit: number): T[] {
  if (limit <= 0) return []
  const heap: T[] = []
  const worse = (a: ScoredVector, b: ScoredVector) =>
    a.score < b.score || (a.score === b.score && a.id > b.id)
  for (const row of rows) {
    if (!Number.isFinite(row.score)) continue
    if (heap.length < limit) {
      heap.push(row)
      let index = heap.length - 1
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2)
        if (!worse(heap[index]!, heap[parent]!)) break
        ;[heap[index], heap[parent]] = [heap[parent]!, heap[index]!]
        index = parent
      }
    } else if (worse(heap[0]!, row)) {
      heap[0] = row
      let index = 0
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1
        if (child + 1 < heap.length && worse(heap[child + 1]!, heap[child]!)) child++
        if (!worse(heap[child]!, heap[index]!)) break
        ;[heap[index], heap[child]] = [heap[child]!, heap[index]!]
        index = child
      }
    }
  }
  return heap.sort((a, b) => b.score - a.score || a.id - b.id)
}
