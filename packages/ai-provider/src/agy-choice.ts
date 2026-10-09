/**
 * Whether the stored AI settings make Antigravity the choice of at least one feature (chat, image
 * generation, image / video analysis, web search). Pure: it reads the raw settings file, so work
 * that costs Antigravity quota or spawns the CLI (the launch-time `/usage` read) can be skipped
 * for people who never chose it.
 *
 * A feature the file does not decide falls back to the agy-first default: Antigravity when it is
 * usable, the old default otherwise. While usability is still unknown (`usable === null`) such a
 * feature makes the answer `unknown`, so the caller can wait for the cheap `agy models` probe.
 */

export type AgyChoice = 'yes' | 'no' | 'unknown'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** A stored provider id, or undefined when the file leaves the feature to the default. */
function stored(value: unknown): string | undefined {
  // a stored 'genspark' keeps normalising to the default (see resolveAiSettings)
  return typeof value === 'string' && value.trim() && value.trim() !== 'genspark'
    ? value.trim()
    : undefined
}

export function agyChoice(raw: unknown, usable: boolean | null): AgyChoice {
  const file = record(raw)
  const media = record(file.media)
  const search = record(file.search)
  const legacyMedia = stored(media.provider)
  const analysis = stored(media.analysisProvider) ?? legacyMedia
  const features: Array<string | undefined> = [
    stored(file.provider),
    stored(media.imageProvider) ?? legacyMedia,
    analysis,
    // a pre-split file used one vendor for all media analysis
    stored(media.videoAnalysisProvider) ?? analysis,
    stored(search.provider),
  ]
  let undecided = false
  for (const choice of features) {
    if (choice === 'agy') return 'yes'
    if (choice === undefined) undecided = true
  }
  if (!undecided) return 'no'
  if (usable === null) return 'unknown'
  return usable ? 'yes' : 'no'
}
