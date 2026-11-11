/** TrueOCR 0.1.1 detector, CTC and reading-order decoders (Apache-2.0). */
import { median, roundEven } from './trueocr-image'

export type LineBox = [number, number, number, number, number]

/** Four-connected core components; mean top/bottom distance, detector stride two. */
export function decodeLines(out: ArrayLike<number>, height: number, width: number): LineBox[] {
  const size = width * height,
    seen = new Uint8Array(size),
    queue = new Int32Array(size)
  const boxes: LineBox[] = []
  for (let p = 0; p < size; p++) {
    if (seen[p] || out[p]! <= 0) continue
    let head = 0,
      tail = 1,
      left = width,
      right = 0,
      top = 0,
      bottom = 0,
      score = 0
    queue[0] = p
    seen[p] = 1
    while (head < tail) {
      const i = queue[head++]!,
        x = i % width,
        y = Math.floor(i / width)
      left = Math.min(left, x)
      right = Math.max(right, x + 1)
      top += (y + 0.5) * 2 - out[size + i]!
      bottom += (y + 0.5) * 2 + out[2 * size + i]!
      score += 1 / (1 + Math.exp(-out[i]!))
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
        if (j >= 0 && j < size && !seen[j] && out[j]! > 0) {
          seen[j] = 1
          queue[tail++] = j
        }
      }
    }
    if (tail < 2) continue
    const y0 = top / tail,
      y1 = bottom / tail,
      ex = 0.15 * Math.max(1, y1 - y0)
    boxes.push([
      Math.fround(left * 2 - ex),
      Math.fround(y0),
      Math.fround(right * 2 + ex),
      Math.fround(y1),
      Math.fround(score / tail),
    ])
  }
  return boxes
}

export function decodeCtc(
  ids: ArrayLike<number | bigint>,
  conf: ArrayLike<number>,
  length: number,
  charset: readonly string[],
): { text: string; confidence: number } {
  let text = '',
    sum = 0,
    count = 0,
    previous = -1
  for (let i = 0; i < length; i++) {
    const id = Number(ids[i])
    if (id !== 0 && id !== previous) {
      if (!Number.isInteger(id) || id < 1 || id > charset.length)
        throw new Error('TrueOCR CTC token outside charset')
      text += charset[id - 1]!
      sum += conf[i]!
      count++
    }
    previous = id
  }
  return {
    text: text.normalize('NFC').replace(/\s+/gu, ' ').trim(),
    confidence: count ? sum / count : 0,
  }
}

export function widthBatches(widths: number[], maxBatch = 32): number[][] {
  const batches: number[][] = []
  for (const i of widths.map((_, i) => i).sort((a, b) => widths[a]! - widths[b]!)) {
    const last = batches.at(-1),
      w = Math.max(widths[i]!, 64)
    if (
      last &&
      last.length < maxBatch &&
      w <= 1.3 * Math.max(widths[last[0]!]!, 64) &&
      (last.length + 1) * w <= 64 * 640
    )
      last.push(i)
    else batches.push([i])
  }
  return batches
}

export function lineFeatures(
  boxes: readonly LineBox[],
  texts: string[],
  width: number,
  height: number,
): Float32Array {
  const result = new Float32Array(boxes.length * 16)
  const mh = median(boxes.map((b) => Math.max(1e-3, b[3] - b[1])))
  boxes.forEach((b, i) => {
    const w = Math.max(1e-3, b[2] - b[0]),
      h = Math.max(1e-3, b[3] - b[1]),
      t = texts[i]!.trim(),
      chars = [...t]
    // Wide/fullwidth characters count twice. The shipped recognizer's charset is Latin/Vietnamese.
    const displayLength = chars.reduce(
      (n, c) =>
        n +
        (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(
          c,
        )
          ? 2
          : 1),
      0,
    )
    const first3 = chars
      .slice(0, 3)
      .join('')
      .replace(/[.)]+$/u, '')
    result.set(
      [
        b[0] / width,
        b[1] / height,
        b[2] / width,
        b[3] / height,
        (b[0] + b[2]) / (2 * width),
        (b[1] + b[3]) / (2 * height),
        w / width,
        Math.log(h / mh),
        Math.log(w / h) / 4,
        (mh / height) * 20,
        t ? Math.log1p(displayLength) / 5 : 0,
        t ? chars.filter((c) => /\p{N}/u.test(c)).length / chars.length : 0,
        t && ('•-–▪◦*·→'.includes(chars[0]!) || (/^\p{N}+$/u.test(first3) && chars.length > 3))
          ? 1
          : 0,
        t.endsWith('-') ? 1 : 0,
        t && '.!?:;。！？：；．'.includes(chars.at(-1)!) ? 1 : 0,
        /^\p{Lu}/u.test(t) ? 1 : 0,
      ],
      i * 16,
    )
  })
  return result
}

function argmax(values: ArrayLike<number>): number {
  let best = 0
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i
  return best
}

export function decodeOrder(a: ArrayLike<number>, n: number): number[] {
  const lp = Float64Array.from(a, (x) => -Math.max(0, -x) - Math.log1p(Math.exp(-Math.abs(x))))
  const ranks = Array.from({ length: n }, (_, i) => {
    let rank = 0
    for (let j = 0; j < n; j++) rank += -lp[i * n + j]! + lp[j * n + i]!
    return rank
  })
  let order = Array.from({ length: n }, (_, i) => i).sort((i, j) => ranks[i]! - ranks[j]!)
  for (let sweep = 0; sweep < 4; sweep++) {
    let improved = false
    for (const x of [...order]) {
      const rest = order.filter((i) => i !== x),
        gains = new Float64Array(n)
      for (const j of rest) gains[0]! += lp[x * n + j]!
      for (let k = 1; k < n; k++)
        gains[k] = gains[k - 1]! + lp[rest[k - 1]! * n + x]! - lp[x * n + rest[k - 1]!]!
      const best = argmax(gains),
        current = order.indexOf(x)
      if (gains[best]! > gains[current]! + 1e-6) {
        rest.splice(best, 0, x)
        order = rest
        improved = true
      }
    }
    if (!improved) break
  }
  return order
}

function topDown(ids: number[], boxes: readonly LineBox[]): number[] {
  const h = Math.max(median(ids.map((i) => boxes[i]![3] - boxes[i]![1])) * 0.5, 1e-3)
  return [...ids].sort(
    (i, j) =>
      roundEven((boxes[i]![1] + boxes[i]![3]) / 2 / h) -
        roundEven((boxes[j]![1] + boxes[j]![3]) / 2 / h) || boxes[i]![0] - boxes[j]![0],
  )
}

function xyCut(ids: number[], boxes: readonly LineBox[]): number[] {
  if (ids.length < 2) return ids
  const cut = (axis: number) => {
    const order = [...ids].sort((i, j) => boxes[i]![axis]! - boxes[j]![axis]!)
    let end = boxes[order[0]!]![axis + 2]!,
      gap = 0,
      k = -1
    for (let p = 1; p < order.length; p++) {
      const b = boxes[order[p]!]!,
        g = b[axis]! - end
      if (g > gap) {
        gap = g
        k = p
      }
      end = Math.max(end, b[axis + 2]!)
    }
    return { order, gap, k }
  }
  const x = cut(0),
    y = cut(1),
    best = y.gap >= x.gap ? y : x
  if (best.k < 0) return topDown(ids, boxes)
  return [...xyCut(best.order.slice(0, best.k), boxes), ...xyCut(best.order.slice(best.k), boxes)]
}

/** Average-linkage same-block clustering, then layout-aware within-block and pairwise block order. */
export function decodeBlocksOrder(
  a: ArrayLike<number>,
  same: ArrayLike<number>,
  boxes: readonly LineBox[],
  cls: ArrayLike<number>,
  classes = 10,
): number[] {
  const n = boxes.length
  if (n < 2) return Array.from({ length: n }, (_, i) => i)
  const groups = Array.from({ length: n }, (_, i) => [i])
  const sums = Float64Array.from(same)
  const alive = new Uint8Array(n).fill(1),
    sizes = new Uint32Array(n).fill(1)
  const means = new Float64Array(n * n)
  const best = new Int32Array(n),
    bestValues = new Float64Array(n)
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) means[i * n + j] = i === j ? -Infinity : sums[i * n + j]!
  const update = (i: number) => {
    let partner = 0
    for (let j = 1; j < n; j++) if (means[i * n + j]! > means[i * n + partner]!) partner = j
    best[i] = partner
    bestValues[i] = means[i * n + partner]!
  }
  for (let i = 0; i < n; i++) {
    sums[i * n + i] = 0
    update(i)
  }
  for (let step = 0; step < n - 1; step++) {
    const p = argmax(bestValues)
    if (bestValues[p]! <= 0) break
    const q = best[p]!,
      left = Math.min(p, q),
      right = Math.max(p, q)
    for (let j = 0; j < n; j++) sums[left * n + j]! += sums[right * n + j]!
    for (let i = 0; i < n; i++) sums[i * n + left]! += sums[i * n + right]!
    sums[left * n + left] = 0
    sizes[left]! += sizes[right]!
    alive[right] = 0
    groups[left]!.push(...groups[right]!)
    for (let j = 0; j < n; j++) {
      const v =
        !alive[j] || j === left ? -Infinity : sums[left * n + j]! / (sizes[left]! * sizes[j]!)
      means[left * n + j] = v
      means[j * n + left] = v
      means[right * n + j] = -Infinity
      means[j * n + right] = -Infinity
    }
    bestValues[right] = -Infinity
    for (let j = 0; j < n; j++)
      if (alive[j]) {
        if (j === left || best[j] === left || best[j] === right) update(j)
        else if (means[j * n + left]! > bestValues[j]!) {
          best[j] = left
          bestValues[j] = means[j * n + left]!
        }
      }
  }
  const blocks = groups.filter((_, i) => alive[i]).map((g) => g.sort((i, j) => i - j))
  const inner = blocks.map((ids) => {
    const votes = new Float32Array(classes)
    for (const i of ids) for (let c = 0; c < classes; c++) votes[c]! += cls[i * classes + c]!
    return [5, 8, 9].includes(argmax(votes)) ? topDown(ids, boxes) : xyCut(ids, boxes)
  })
  const m = blocks.length,
    ab = new Float32Array(m * m)
  for (let p = 0; p < m; p++)
    for (let q = p + 1; q < m; q++) {
      let sum = 0
      for (const i of blocks[p]!) for (const j of blocks[q]!) sum += a[i * n + j]!
      ab[p * m + q] = sum / (blocks[p]!.length * blocks[q]!.length)
      ab[q * m + p] = -ab[p * m + q]!
    }
  return decodeOrder(ab, m).flatMap((i) => inner[i]!)
}
