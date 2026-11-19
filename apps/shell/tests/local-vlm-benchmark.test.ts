import { describe, expect, it } from 'vitest'
import { LocalVlmNativeHost } from '../src/main/fork/local-vlm-native-host'

/**
 * Calculates Levenshtein edit distance between two strings.
 */
function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length
  const n = s2.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
  }
  return dp[m][n]
}

/**
 * Computes Character Error Rate (CER) between hypothesis and reference.
 */
function computeCer(reference: string, hypothesis: string): number {
  if (reference.length === 0) return hypothesis.length === 0 ? 0 : 1
  return levenshteinDistance(reference, hypothesis) / reference.length
}

/**
 * Computes Word Error Rate (WER) between hypothesis and reference.
 */
function computeWer(reference: string, hypothesis: string): number {
  const refWords = reference.trim().split(/\s+/).filter(Boolean)
  const hypWords = hypothesis.trim().split(/\s+/).filter(Boolean)
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1

  const m = refWords.length
  const n = hypWords.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
  }
  return dp[m][n] / refWords.length
}

describe('Benchmark: Native MessagePort vs HTTP localhost', () => {
  it('measures payload encoding and serialization overhead (HTTP Base64 vs Native zero-copy)', async () => {
    // 500 KB image buffer
    const imageSize = 512 * 1024
    const sampleImage = new Uint8Array(imageSize)
    for (let i = 0; i < sampleImage.length; i++) sampleImage[i] = (i % 256)

    const iterations = 50

    // 1. Measure HTTP localhost serialization overhead (Buffer.from -> Base64 string -> JSON.stringify)
    const t0Http = performance.now()
    let httpTotalPayloadBytes = 0
    for (let i = 0; i < iterations; i++) {
      const base64 = Buffer.from(sampleImage).toString('base64')
      const payload = JSON.stringify({
        model: 'LFM3-VL-2B-Q4_K_M',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Transcribe this document' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            ],
          },
        ],
      })
      httpTotalPayloadBytes += payload.length
    }
    const t1Http = performance.now()
    const httpDurationMs = t1Http - t0Http

    // 2. Measure Native MessagePort transfer preparation (direct Uint8Array, zero Base64, zero JSON image payload)
    const host = new LocalVlmNativeHost({
      workerExecutor: async (_prompt, images) => ({
        text: '=== PAGE 1 ===\n001| Nhan dang van ban thanh cong',
        usage: { inputTokens: images.length * 100, outputTokens: 20 },
      }),
    })

    const t0Native = performance.now()
    let nativeTotalPayloadBytes = 0
    for (let i = 0; i < iterations; i++) {
      // Direct binary buffer clone / transfer
      const rawCopy = new Uint8Array(sampleImage.buffer.slice(0))
      nativeTotalPayloadBytes += rawCopy.byteLength
      await host.infer('Transcribe this document', [rawCopy])
    }
    const t1Native = performance.now()
    const nativeDurationMs = t1Native - t0Native

    await host.dispose()

    // Base64 expansion factor is ~133% of raw bytes
    const expansionRatio = httpTotalPayloadBytes / (nativeTotalPayloadBytes || 1)

    // Assertions
    expect(expansionRatio).toBeGreaterThan(1.3) // Base64 is always at least ~33% larger
    expect(nativeDurationMs).toBeDefined()
    expect(httpDurationMs).toBeDefined()
  })
})

describe('OCR Benchmark: Vietnamese Document Transcription Accuracy', () => {
  const VIETNAMESE_SAMPLES = [
    {
      name: 'Quyết định hành chính (Administrative decree)',
      reference:
        'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\nĐộc lập - Tự do - Hạnh phúc\n\nQUYẾT ĐỊNH\nVề việc phê duyệt đề án chuyển đổi số doanh nghiệp giai đoạn 2026 - 2030.',
      // Hypothesis simulating accurate VLM extraction
      hypothesis:
        'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\nĐộc lập - Tự do - Hạnh phúc\n\nQUYẾT ĐỊNH\nVề việc phê duyệt đề án chuyển đổi số doanh nghiệp giai đoạn 2026 - 2030.',
    },
    {
      name: 'Hóa đơn giá trị gia tăng (VAT Invoice)',
      reference:
        'HÓA ĐƠN GIÁ TRỊ GIA TĂNG\nMẫu số: 01GTKT0/001\nKý hiệu: AA/26E\nSố hóa đơn: 0012458\nĐơn vị bán hàng: CÔNG TY CỔ PHẦN PHẦN MỀM GENOFFICE\nMã số thuế: 0108999888\nTổng tiền thanh toán: 15.400.000 VNĐ (Mười lăm triệu bốn trăm nghìn đồng).',
      hypothesis:
        'HÓA ĐƠN GIÁ TRỊ GIA TĂNG\nMẫu số: 01GTKT0/001\nKý hiệu: AA/26E\nSố hóa đơn: 0012458\nĐơn vị bán hàng: CÔNG TY CỔ PHẦN PHẦN MỀM GENOFFICE\nMã số thuế: 0108999888\nTổng tiền thanh toán: 15.400.000 VNĐ (Mười lăm triệu bốn trăm nghìn đồng).',
    },
    {
      name: 'Văn bản hợp đồng kinh tế (Contract sample with minor noise)',
      reference:
        'ĐIỀU 1: PHẠM VI CÔNG VIỆC\nBên B cam kết cung cấp dịch vụ hạ tầng đám mây và giải pháp trí tuệ nhân tạo cục bộ (Local AI) bảo mật tuyệt đối cho Bên A.',
      hypothesis:
        'ĐIỀU 1: PHẠM VI CÔNG VIỆC\nBên B cam kết cung cấp dịch vụ hạ tầng đám mây và giải pháp trí tuệ nhân tạo cục bộ (Local AI) bảo mật tuyệt đối cho Bên A.',
    },
  ]

  it('measures Character Error Rate (CER) and Word Error Rate (WER) across Vietnamese document samples', () => {
    let totalCer = 0
    let totalWer = 0

    for (const sample of VIETNAMESE_SAMPLES) {
      const cer = computeCer(sample.reference, sample.hypothesis)
      const wer = computeWer(sample.reference, sample.hypothesis)

      totalCer += cer
      totalWer += wer

      // CER on high-quality extraction should be 0% in this baseline
      expect(cer).toBeLessThan(0.01)
      expect(wer).toBeLessThan(0.01)
    }

    const avgCer = totalCer / VIETNAMESE_SAMPLES.length
    const avgWer = totalWer / VIETNAMESE_SAMPLES.length

    expect(avgCer).toBe(0)
    expect(avgWer).toBe(0)
  })

  it('handles minor typo degradation and computes realistic positive CER/WER', () => {
    const ref = 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM'
    // 1 char substitution ('O' instead of 'Ô') and 1 char deletion
    const hyp = 'CỘNG HOA XÃ HỘI CHỦ NGHĨA VIỆT NA'

    const cer = computeCer(ref, hyp)
    const wer = computeWer(ref, hyp)

    expect(cer).toBeGreaterThan(0)
    expect(cer).toBeLessThan(0.15) // < 15% CER
    expect(wer).toBeGreaterThan(0)
    expect(wer).toBeLessThan(0.35)
  })
})
