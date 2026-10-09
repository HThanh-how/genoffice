/**
 * Decides whether a locally recognised page is good enough to stay local or should be offered to
 * the cloud reader (Antigravity). Rule from the offline OCR benchmark:
 *
 *   S = C x V
 *   C = character-weighted mean of the engine's own confidence (0..1)
 *   V = share of alphabetic tokens (2+ letters) that are valid Vietnamese syllables, tone-insensitive
 *
 * Page escalates when S is below the engine's threshold. Thresholds are per engine (and, for
 * Tesseract, per page-segmentation mode) because the engines' confidences are not comparable:
 * they were fitted on clean pages pooled with synthetically degraded copies (72 dpi + JPEG q40;
 * blur + noise + rotation) so that at most ~30% of pages escalate, and are starting points to be
 * re-fitted on real escalation outcomes.
 */
import { normalizeDocumentText } from '../normalization'
import type { LocalOcrRecognition, LocalOcrToken } from '../runtime/local-ocr-engine'
import { alphaTokens, isVietnameseSyllable } from './viet-syllables'

/** Apple Vision `accurate`, line confidence. CV precision 0.97 / recall 0.88; 0% of clean real pages escalate. */
export const VISION_ESCALATION_THRESHOLD = 0.73
/** RapidOCR PP-OCRv6-tiny (phase 2, not wired): 0.94 / 1.00; 1% of clean real pages escalate. */
export const RAPIDOCR_ESCALATION_THRESHOLD = 0.48
/**
 * Tesseract `vie` fast, psm 6, background-normalised, ~150 dpi. Precision 0.90 but recall only
 * 0.67 and it is blind to wrong digits on stamped invoices: that is what the token-level invoice
 * number check below is for.
 */
export const TESSERACT_ESCALATION_THRESHOLD = 0.25

/** Word confidence (0..100 scale of Tesseract) under which an invoice number is not trusted. */
export const INVOICE_NUMBER_MIN_WORD_CONFIDENCE = 0.7

/**
 * Fewer alphabetic tokens than this means a blank / photo / stamp-only page (or a failed read).
 * NOT validated on real data (no such page in the calibration sample); a conservative floor.
 */
export const MIN_ALPHA_TOKENS = 3

const THRESHOLDS: Readonly<Record<string, number>> = {
  'apple-vision': VISION_ESCALATION_THRESHOLD,
  'tesseract-vie': TESSERACT_ESCALATION_THRESHOLD,
  'rapidocr-ppocrv6-tiny': RAPIDOCR_ESCALATION_THRESHOLD,
}

export function escalationThresholdFor(engineId: string): number {
  // an unknown engine gets the strictest known threshold: better to ask the cloud than to trust it
  return THRESHOLDS[engineId] ?? VISION_ESCALATION_THRESHOLD
}

export interface PageScore {
  /** S = C x V */
  S: number
  C: number
  V: number
  alphaTokens: number
}

/** Character-weighted mean confidence of tokens/lines; falls back to the engine's page mean. */
function meanConfidence(page: Pick<LocalOcrRecognition, 'tokens' | 'meanConfidence'>): number {
  const tokens = page.tokens
  if (tokens && tokens.length) {
    let weight = 0
    let sum = 0
    for (const token of tokens) {
      const length = token.text.length
      weight += length
      sum += length * clamp01(token.confidence)
    }
    if (weight > 0) return sum / weight
  }
  return clamp01(page.meanConfidence)
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

export function scorePage(page: Pick<LocalOcrRecognition, 'text' | 'tokens' | 'meanConfidence'>): PageScore {
  const tokens = alphaTokens(page.text)
  const valid = tokens.reduce((n, token) => n + (isVietnameseSyllable(token) ? 1 : 0), 0)
  const V = tokens.length ? valid / tokens.length : 0
  const C = meanConfidence(page)
  return { S: C * V, C, V, alphaTokens: tokens.length }
}

const NUMBER_LABELS = new Set(['so', 'no', 'n0'])
const DIGITS = /^\d{3,}$/

function foldLabel(text: string): string {
  return normalizeDocumentText(text).replace(/ /g, '')
}

/**
 * Token-level invoice-number check: a 'Số' / 'No' label followed (within two tokens, punctuation
 * skipped) by a run of digits whose word confidence is below 0.7. On stamped invoices Tesseract
 * misreads digits yet reports a good page score, and a wrong 7-digit number is worse than none.
 */
export function lowConfidenceInvoiceNumber(tokens: readonly LocalOcrToken[] | undefined): boolean {
  if (!tokens) return false
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!.text
    // "Số:0433" glued, or "Số:" / "Số" alone followed by the number
    const glued = /^(\p{L}{2})[:.]?(\d{3,})$/u.exec(raw)
    if (glued && NUMBER_LABELS.has(foldLabel(glued[1]!))) {
      if (tokens[i]!.confidence < INVOICE_NUMBER_MIN_WORD_CONFIDENCE) return true
      continue
    }
    const label = foldLabel(raw.replace(/[:.]+$/u, ''))
    if (!NUMBER_LABELS.has(label)) continue
    for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) {
      const next = tokens[j]!
      const stripped = next.text.replace(/^[:.\-–]+|[:.\-–]+$/gu, '')
      if (!stripped) continue // lone punctuation
      if (DIGITS.test(stripped)) {
        if (next.confidence < INVOICE_NUMBER_MIN_WORD_CONFIDENCE) return true
      }
      break
    }
  }
  return false
}

// ---- identity / legal papers recognised by CONTENT --------------------------------------------
// File names are checked elsewhere (isSensitiveName). A scan called "scan0001.pdf" would pass that
// gate, so the recognised text itself is checked as well: such a page is never offered to the cloud.
const SENSITIVE_PHRASES = [
  'can cuoc cong dan',
  'chung minh nhan dan',
  'so ho khau',
  'ho khau thuong tru',
  'giay chung nhan quyen su dung dat',
  'so dinh danh ca nhan',
  'passport',
  'ho chieu',
  'giay phep lai xe',
  'driver license',
  'giay khai sinh',
]

/** True when the page text looks like an identity / residence / land-title / licence paper. */
export function looksSensitiveContent(text: string): boolean {
  const norm = ` ${normalizeDocumentText(text.slice(0, 6000))} `
  return SENSITIVE_PHRASES.some((phrase) => norm.includes(` ${phrase} `))
}

export type EscalationReason =
  | 'ok'
  | 'low-score'
  | 'too-little-text'
  | 'invoice-number-low-confidence'
  | 'sensitive-content'

export interface EscalationVerdict {
  escalate: boolean
  S: number
  reason: EscalationReason
  score: PageScore
}

/**
 * `engine` is the engine id (or the descriptor); thresholds are looked up per engine.
 * Sensitive content wins over everything: the page stays local and `escalate` is false.
 */
export function shouldEscalate(
  page: Pick<LocalOcrRecognition, 'text' | 'tokens' | 'meanConfidence'>,
  engine: string | { id: string },
): EscalationVerdict {
  const id = typeof engine === 'string' ? engine : engine.id
  const score = scorePage(page)
  if (looksSensitiveContent(page.text))
    return { escalate: false, S: score.S, reason: 'sensitive-content', score }
  if (score.alphaTokens < MIN_ALPHA_TOKENS)
    return { escalate: true, S: score.S, reason: 'too-little-text', score }
  if (score.S < escalationThresholdFor(id))
    return { escalate: true, S: score.S, reason: 'low-score', score }
  if (id === 'tesseract-vie' && lowConfidenceInvoiceNumber(page.tokens))
    return { escalate: true, S: score.S, reason: 'invoice-number-low-confidence', score }
  return { escalate: false, S: score.S, reason: 'ok', score }
}
