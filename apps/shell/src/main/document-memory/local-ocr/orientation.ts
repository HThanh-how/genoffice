/** Confidence probing works with the bundled LSTM-only model; OSD requires legacy data. */
export const ORIENTATION_PROBE_EDGE_PX = 800
export const ORIENTATION_MIN_CONFIDENCE = 60
export const ORIENTATION_MIN_GAIN = 15
export type QuarterTurn = 0 | 90 | 180 | 270

/** Scores use Tesseract's 0..100 mean confidence. Ties always preserve the original. */
export function chooseOrientation(scores: readonly number[]): QuarterTurn {
  const original = scores[0]
  if (!Number.isFinite(original)) return 0
  let best = 0
  for (let i = 1; i < Math.min(4, scores.length); i++) {
    if (Number.isFinite(scores[i]) && scores[i] > scores[best]) best = i
  }
  return scores[best] >= ORIENTATION_MIN_CONFIDENCE &&
    scores[best] - original >= ORIENTATION_MIN_GAIN
    ? ((best * 90) as QuarterTurn)
    : 0
}

export async function probeOrientation(
  recognize: (degrees: QuarterTurn) => Promise<number>,
): Promise<QuarterTurn> {
  const scores = [await recognize(0)]
  // At this score no rotation can beat the original by more than our margin.
  if (scores[0] >= 100 - ORIENTATION_MIN_GAIN) return 0
  for (const degrees of [90, 180, 270] as const) scores.push(await recognize(degrees))
  return chooseOrientation(scores)
}
