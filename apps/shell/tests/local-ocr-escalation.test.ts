import { describe, expect, it } from 'vitest'
import {
  INVOICE_NUMBER_MIN_WORD_CONFIDENCE,
  RAPIDOCR_ESCALATION_THRESHOLD,
  TESSERACT_ESCALATION_THRESHOLD,
  VISION_ESCALATION_THRESHOLD,
  escalationThresholdFor,
  looksSensitiveContent,
  lowConfidenceInvoiceNumber,
  scorePage,
  shouldEscalate,
} from '../src/main/document-memory/local-ocr/escalation'
import {
  alphaTokens,
  isVietnameseSyllable,
  stripVietnameseTones,
  syllableFraction,
  vietnameseSyllables,
} from '../src/main/document-memory/local-ocr/viet-syllables'
import type { LocalOcrToken } from '../src/main/document-memory/runtime/local-ocr-engine'

const words = (text: string, confidence: number): LocalOcrToken[] =>
  text.split(/\s+/).map((word) => ({ text: word, confidence }))

describe('Vietnamese syllable table (generated from phonotactics)', () => {
  it('is small, generated, and tone-insensitive', () => {
    expect(vietnameseSyllables().size).toBeGreaterThan(4000)
    expect(vietnameseSyllables().size).toBeLessThan(5500)
    for (const word of ['Nguyễn', 'Việt', 'nghiêng', 'Tiền', 'Giang', 'hóa', 'hoá', 'đơn', 'Thị', 'ĐƯỜNG', 'tăng', 'quý'])
      expect(isVietnameseSyllable(word), word).toBe(true)
    // the same syllable under every tone mark is one entry
    for (const tone of ['ma', 'má', 'mà', 'mả', 'mã', 'mạ']) expect(isVietnameseSyllable(tone), tone).toBe(true)
  })

  it('rejects OCR garbage and strips only tone marks', () => {
    for (const junk of ['xcvb', 'ttirrn', 'qwrty', 'hhhh', 'lllii']) expect(isVietnameseSyllable(junk), junk).toBe(false)
    expect(stripVietnameseTones('Nguyễn')).toBe('nguyên') // circumflex stays, tilde goes
    expect(stripVietnameseTones('Đơn')).toBe('đơn')
    expect(alphaTokens('Số: 0433 a bc')).toEqual(['Số', 'bc']) // digits and single letters are not tokens
  })

  it('syllableFraction on real vs garbage text', () => {
    expect(syllableFraction('Hóa đơn giá trị gia tăng').fraction).toBe(1)
    expect(syllableFraction('xcvb ttirrn qwrty').fraction).toBe(0)
  })
})

describe('scorePage: S = C x V', () => {
  it('weights confidence by characters', () => {
    const tokens: LocalOcrToken[] = [
      { text: 'Hóa', confidence: 1 },
      { text: 'đơn', confidence: 1 },
      { text: 'xx', confidence: 0 },
    ]
    const score = scorePage({ text: 'Hóa đơn xx', tokens, meanConfidence: 0.5 })
    expect(score.C).toBeCloseTo(6 / 8, 5)
    expect(score.V).toBeCloseTo(2 / 3, 5)
    expect(score.S).toBeCloseTo(score.C * score.V, 5)
  })

  it('falls back to the engine mean when there are no tokens and clamps nonsense', () => {
    expect(scorePage({ text: 'Hóa đơn', meanConfidence: 0.8 }).C).toBe(0.8)
    expect(scorePage({ text: 'Hóa đơn', meanConfidence: 7 }).C).toBe(1)
    expect(scorePage({ text: 'Hóa đơn', meanConfidence: Number.NaN }).C).toBe(0)
  })
})

describe('shouldEscalate', () => {
  const GOOD =
    'HÓA ĐƠN GIÁ TRỊ GIA TĂNG Số 0433 Đơn vị bán hàng Công ty Viettel Tiền Giang Địa chỉ thành phố Mỹ Tho'

  it('thresholds are the calibrated per-engine constants', () => {
    expect([VISION_ESCALATION_THRESHOLD, RAPIDOCR_ESCALATION_THRESHOLD, TESSERACT_ESCALATION_THRESHOLD]).toEqual([0.73, 0.48, 0.25])
    expect(escalationThresholdFor('apple-vision')).toBe(0.73)
    expect(escalationThresholdFor('tesseract-vie')).toBe(0.25)
    expect(escalationThresholdFor('rapidocr-ppocrv6-tiny')).toBe(0.48)
    expect(escalationThresholdFor('who-knows')).toBe(0.73) // unknown engine: strictest
  })

  it('keeps a clean, confident page local', () => {
    const verdict = shouldEscalate({ text: GOOD, tokens: words(GOOD, 0.95), meanConfidence: 0.95 }, 'apple-vision')
    expect(verdict).toMatchObject({ escalate: false, reason: 'ok' })
    expect(verdict.S).toBeGreaterThan(0.73)
  })

  it('escalates garbage text even at a high engine confidence (validity V catches it)', () => {
    const junk = 'xcvb ttirrn qwrty hhhh lllii vnmz kkkp wwwq'
    const verdict = shouldEscalate({ text: junk, tokens: words(junk, 0.9), meanConfidence: 0.9 }, 'apple-vision')
    expect(verdict).toMatchObject({ escalate: true, reason: 'low-score' })
    expect(verdict.score.V).toBe(0)
  })

  it('escalates a low-confidence read of fine-looking words', () => {
    const verdict = shouldEscalate({ text: GOOD, tokens: words(GOOD, 0.4), meanConfidence: 0.4 }, 'apple-vision')
    expect(verdict.escalate).toBe(true)
    expect(verdict.S).toBeLessThan(0.73)
    // the same page is acceptable for Tesseract, whose threshold is 0.25 on its own confidence scale
    const unlabeled = GOOD.replace('Số 0433 ', '')
    expect(shouldEscalate({ text: unlabeled, tokens: words(unlabeled, 0.4), meanConfidence: 0.4 }, 'tesseract-vie').escalate).toBe(false)
  })

  it('a diacritic-less page scores lower than the accented one (the syllable table is diacritic-sensitive)', () => {
    const plain = 'HOA DON GIA TRI GIA TANG So 0433 Cong ty TNHH Viettel Tien Giang Nguyen Hue'
    const accented = shouldEscalate({ text: GOOD, tokens: words(GOOD, 0.9), meanConfidence: 0.9 }, 'apple-vision')
    const folded = shouldEscalate({ text: plain, tokens: words(plain, 0.9), meanConfidence: 0.9 }, 'apple-vision')
    expect(folded.score.V).toBeLessThan(accented.score.V)
    expect(folded.escalate).toBe(true) // 'Viettel', 'Nguyen' ... are not valid toneless-but-accented syllables
  })

  it('too little text escalates (blank page, photo, failed read)', () => {
    expect(shouldEscalate({ text: '', meanConfidence: 0 }, 'tesseract-vie')).toMatchObject({ escalate: true, reason: 'too-little-text' })
    expect(shouldEscalate({ text: 'Số 12', meanConfidence: 0.99 }, 'apple-vision').reason).toBe('too-little-text')
  })

  it('Tesseract: a wrong-digit invoice number escalates a page whose score looks fine', () => {
    const tokens = [...words('HÓA ĐƠN GIÁ TRỊ GIA TĂNG', 0.92), { text: 'Số:', confidence: 0.95 }, { text: '0433', confidence: 0.35 }, ...words(GOOD, 0.92)]
    const text = tokens.map((t) => t.text).join(' ')
    const verdict = shouldEscalate({ text, tokens, meanConfidence: 0.9 }, 'tesseract-vie')
    expect(verdict.S).toBeGreaterThan(TESSERACT_ESCALATION_THRESHOLD)
    expect(verdict).toMatchObject({ escalate: true, reason: 'invoice-number-low-confidence' })
    // the same word confidence is ignored for Vision, which has no per-word confidence to check
    expect(shouldEscalate({ text, tokens, meanConfidence: 0.95 }, 'apple-vision').reason).not.toBe('invoice-number-low-confidence')
    // a confident number passes
    const sure = tokens.map((t) => (t.text === '0433' ? { ...t, confidence: 0.9 } : t))
    expect(shouldEscalate({ text, tokens: sure, meanConfidence: 0.9 }, 'tesseract-vie').escalate).toBe(false)
  })

  it('invoice-number check handles label forms, punctuation and non-invoice digits', () => {
    const low = INVOICE_NUMBER_MIN_WORD_CONFIDENCE - 0.1
    const t = (text: string, confidence: number): LocalOcrToken => ({ text, confidence })
    expect(lowConfidenceInvoiceNumber([t('Số', 0.9), t(':', 0.9), t('0000406', low)])).toBe(true)
    expect(lowConfidenceInvoiceNumber([t('No.', 0.9), t('0000406', low)])).toBe(true)
    expect(lowConfidenceInvoiceNumber([t('Số:0433', low)])).toBe(true)
    expect(lowConfidenceInvoiceNumber([t('Số', 0.9), t('0000406', 0.9)])).toBe(false)
    expect(lowConfidenceInvoiceNumber([t('Số', 0.9), t('lượng', low)])).toBe(false) // not digits
    expect(lowConfidenceInvoiceNumber([t('Tổng', 0.9), t('0000406', low)])).toBe(false) // no label
    expect(lowConfidenceInvoiceNumber(undefined)).toBe(false)
  })
})

describe('content-based sensitivity', () => {
  it('recognises identity / residence / land-title text and never escalates it', () => {
    const idText = 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM CĂN CƯỚC CÔNG DÂN Số định danh cá nhân'
    expect(looksSensitiveContent(idText)).toBe(true)
    expect(looksSensitiveContent('Giấy chứng nhận quyền sử dụng đất, quyền sở hữu nhà ở')).toBe(true)
    expect(looksSensitiveContent('Sổ hộ khẩu gia đình')).toBe(true)
    expect(looksSensitiveContent('Sơ đồ tổ chức công ty')).toBe(false)
    // a terrible read of such a page still stays local
    expect(shouldEscalate({ text: idText, tokens: words(idText, 0.1), meanConfidence: 0.1 }, 'apple-vision')).toMatchObject({
      escalate: false,
      reason: 'sensitive-content',
    })
  })
})
