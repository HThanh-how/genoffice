/**
 * Rough "how many documents fit" estimate for the index-size setting. Pure and renderer-safe (no node imports).
 *
 * This is an ESTIMATE for an average text document (a few pages of Office/PDF text), not a promise: scanned PDFs,
 * images and very long documents cost more, short notes cost less.
 *
 * Derivation (calibrated on the standard profile, 320-dim vectors, ~8 chunks per text document):
 *   lexical part  = 28 KB per document   (chunk text + FTS index + document/metadata rows)
 *   vector part   = chunks x (dimensions x 4 bytes + per-vector overhead)
 *                   float32 canonical vector, plus ~220 B for the row key and the ANN graph links
 *   at 320 dims   = 28_000 + 8 x (320 x 4 + 220) = 40_000 bytes  ->  the "about 40 KB per document" figure.
 * A wider profile (e.g. 512 dims) costs proportionally more for the vector part only.
 */
export const LEXICAL_BYTES_PER_DOC = 28_000
export const ESTIMATED_CHUNKS_PER_DOC = 8
export const VECTOR_ROW_OVERHEAD_BYTES = 220
export const BYTES_PER_FLOAT32 = 4

export interface DocumentCapacityEstimate {
  /** bytes one average text document is expected to occupy */
  bytesPerDocument: number
  /** how many such documents fit in the quota (rounded down to 3 significant figures) */
  documents: number
}

/** Bytes one stored vector costs: float32 payload plus row/ANN overhead. 0 or invalid dimensions -> 0 (no vectors). */
export function bytesPerVector(dimensions: number | null | undefined): number {
  if (typeof dimensions !== 'number' || !Number.isFinite(dimensions) || dimensions <= 0) return 0
  return Math.round(dimensions) * BYTES_PER_FLOAT32 + VECTOR_ROW_OVERHEAD_BYTES
}

/**
 * @param quotaBytes the user-facing (soft) index size
 * @param dimensions the active embedding profile's vector dimension; omit/0 for a lexical-only estimate
 */
export function estimateDocumentCapacity(quotaBytes: number, dimensions?: number | null): DocumentCapacityEstimate {
  const vectors = bytesPerVector(dimensions)
  const bytesPerDocument = LEXICAL_BYTES_PER_DOC + (vectors > 0 ? ESTIMATED_CHUNKS_PER_DOC * vectors : 0)
  if (typeof quotaBytes !== 'number' || !Number.isFinite(quotaBytes) || quotaBytes <= 0) {
    return { bytesPerDocument, documents: 0 }
  }
  const raw = Math.floor(quotaBytes / bytesPerDocument)
  // round down to 3 significant figures: "about 74 900", never a falsely precise "74 931"
  const magnitude = raw >= 1000 ? 10 ** (Math.floor(Math.log10(raw)) - 2) : 1
  return { bytesPerDocument, documents: Math.floor(raw / magnitude) * magnitude }
}

/** Decimal units, as in the settings file and the UI ("1 GB" = 1_000_000_000 bytes). */
export const QUOTA_MIN_BYTES = 500 * 1_000_000
export const QUOTA_MAX_BYTES = 100 * 1_000_000_000
export const QUOTA_PRESET_BYTES = { '1gb': 1_000_000_000, '3gb': 3_000_000_000, '5gb': 5_000_000_000 } as const
export type QuotaPresetKey = keyof typeof QUOTA_PRESET_BYTES

/**
 * Preset suggested for a computer's RAM: under 6 GiB the light 1 GB index, under 12 GiB 3 GB, otherwise 5 GB.
 * Same thresholds as main's memory tier (memory-tier.ts) which picks the default for a fresh install; a test keeps them equal.
 */
export function recommendQuotaPreset(totalMemGiB: number): QuotaPresetKey {
  if (!(totalMemGiB >= 6)) return '1gb'
  return totalMemGiB < 12 ? '3gb' : '5gb'
}

export function isQuotaInRange(bytes: unknown): bytes is number {
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= QUOTA_MIN_BYTES && bytes <= QUOTA_MAX_BYTES
}

/** Decimal size for display next to the quota, e.g. "2.4 GB", "840 MB". */
export function formatQuotaBytes(bytes: number | null | undefined, locale?: string): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const fmt = (v: number, digits: number) => v.toLocaleString(locale, { maximumFractionDigits: digits })
  if (n >= 1e9) return `${fmt(n / 1e9, n >= 1e10 ? 1 : 2)} GB`
  if (n >= 1e6) return `${fmt(n / 1e6, 0)} MB`
  if (n >= 1e3) return `${fmt(n / 1e3, 0)} KB`
  return `${fmt(n, 0)} B`
}
