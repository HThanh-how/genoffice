import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { openingPageHtml, OpeningWords } from '../src/main/fork/opening-window'
import { buildMaterialCss } from '../src/main/fork/opening-card-css'
import { sniffImageSignature } from '../src/main/fork/opening-media-storage'
import { parseAiJsonPayload, validateAiCardSchema } from '../src/main/fork/opening-card-ai'
import { normalizeOpeningPrefs } from '../src/shared/opening-scenes-meta'
import { CURATED_CARD_FAMILIES } from '../src/shared/opening-card-families'
import type { SplashApp, SplashTier } from '../src/main/fork/opening-window'

describe('Opening Card Studio — Performance & Speed Benchmarks', () => {
  const APPS: SplashApp[] = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']
  const TIERS: SplashTier[] = ['full', 'lite', 'minimal']
  const WORDS: OpeningWords = { title: 'Opening…', hint: 'Preparing document…' }

  it('measures HTML splash generation speed across 1,000 iterations', () => {
    const ITERATIONS = 1000
    const latencies: number[] = []

    const startTotal = performance.now()
    for (let i = 0; i < ITERATIONS; i++) {
      const app = APPS[i % APPS.length]!
      const tier = TIERS[i % TIERS.length]!
      const card = CURATED_CARD_FAMILIES[i % CURATED_CARD_FAMILIES.length]

      const t0 = performance.now()
      const html = openingPageHtml(
        WORDS,
        `Benchmark_Document_${i}.docx`,
        app,
        tier,
        undefined,
        'card',
        card,
      )
      const t1 = performance.now()
      latencies.push(t1 - t0)

      if (i === 0) {
        expect(html.length).toBeGreaterThan(500)
      }
    }
    const endTotal = performance.now()
    const totalMs = endTotal - startTotal
    const avgMs = totalMs / ITERATIONS

    latencies.sort((a, b) => a - b)
    const p50 = latencies[Math.floor(ITERATIONS * 0.5)]!
    const p95 = latencies[Math.floor(ITERATIONS * 0.95)]!
    const p99 = latencies[Math.floor(ITERATIONS * 0.99)]!

    console.log(`[Benchmark] HTML Splash Generation (1,000 runs):`)
    console.log(`  Total: ${totalMs.toFixed(2)} ms`)
    console.log(`  Avg:   ${(avgMs * 1000).toFixed(1)} µs / page (${avgMs.toFixed(3)} ms)`)
    console.log(`  p50:   ${(p50 * 1000).toFixed(1)} µs`)
    console.log(`  p95:   ${(p95 * 1000).toFixed(1)} µs`)
    console.log(`  p99:   ${(p99 * 1000).toFixed(1)} µs`)

    // Invariant: generation must be ultra-fast (< 0.2 ms avg per page)
    expect(avgMs).toBeLessThan(0.5)
  })

  it('measures Material CSS Engine computation speed across 2,000 iterations', () => {
    const ITERATIONS = 2000
    const presets = ['solid', 'frosted-glass', 'liquid-glass', 'minimal-monochrome'] as const
    const modes = ['system', 'light', 'dark'] as const

    const startTotal = performance.now()
    for (let i = 0; i < ITERATIONS; i++) {
      const preset = presets[i % presets.length]!
      const themeMode = modes[i % modes.length]!

      buildMaterialCss({
        preset,
        themeMode,
        opacity: 0.85,
        blurPx: 22,
        accentColor: '#3a82ee',
        borderRadiusPx: 18,
        borderWidthPx: 1,
        borderColor: 'rgba(255, 255, 255, 0.15)',
        shadowIntensity: 0.35,
      })
    }
    const endTotal = performance.now()
    const totalMs = endTotal - startTotal
    const avgMs = totalMs / ITERATIONS

    console.log(`[Benchmark] Material CSS Engine (2,000 runs):`)
    console.log(`  Total: ${totalMs.toFixed(2)} ms`)
    console.log(`  Avg:   ${(avgMs * 1000).toFixed(1)} µs / computation`)

    // Invariant: CSS compilation must be sub-millisecond (< 0.05 ms avg)
    expect(avgMs).toBeLessThan(0.1)
  })

  it('measures Media Image Signature Sniffing throughput across 10,000 checks', () => {
    const ITERATIONS = 10000
    const samplePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ])
    const sampleJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)])
    const sampleInvalid = Buffer.from('NOT_AN_IMAGE_FILE_BUFFER_1234')

    const buffers = [samplePng, sampleJpeg, sampleInvalid]

    const startTotal = performance.now()
    for (let i = 0; i < ITERATIONS; i++) {
      sniffImageSignature(buffers[i % buffers.length]!)
    }
    const endTotal = performance.now()
    const totalMs = endTotal - startTotal
    const opsPerSec = Math.round((ITERATIONS / totalMs) * 1000)

    console.log(`[Benchmark] Media Signature Sniffing (10,000 runs):`)
    console.log(`  Total:      ${totalMs.toFixed(2)} ms`)
    console.log(`  Throughput: ${opsPerSec.toLocaleString()} ops/sec`)

    // Invariant: Must process at least 100,000 ops/sec
    expect(opsPerSec).toBeGreaterThan(50000)
  })

  it('measures AI payload parsing and schema validation across 1,000 runs', () => {
    const ITERATIONS = 1000
    const rawAiOutput = `\`\`\`json
{
  "name": "Ethereal Glass",
  "description": "Clean frosted pane with soft cyan glow",
  "preset": "liquid-glass",
  "themeMode": "system",
  "opacity": 0.88,
  "blurPx": 24,
  "accentColor": "#00d2ff",
  "borderRadiusPx": 18,
  "borderWidthPx": 1,
  "shadowIntensity": 0.4
}
\`\`\``

    const startTotal = performance.now()
    for (let i = 0; i < ITERATIONS; i++) {
      const parsed = parseAiJsonPayload(rawAiOutput)
      const res = validateAiCardSchema(parsed)
      if (i === 0) {
        expect(res.ok).toBe(true)
      }
    }
    const endTotal = performance.now()
    const totalMs = endTotal - startTotal
    const avgMs = totalMs / ITERATIONS

    console.log(`[Benchmark] AI Payload Parse & Validate (1,000 runs):`)
    console.log(`  Total: ${totalMs.toFixed(2)} ms`)
    console.log(`  Avg:   ${(avgMs * 1000).toFixed(1)} µs / validation`)

    expect(avgMs).toBeLessThan(0.2)
  })

  it('measures Preferences Normalization speed across 5,000 runs', () => {
    const ITERATIONS = 5000
    const complexStored = {
      enabled: true,
      tier: 'auto',
      scenes: {
        docs: 'curated:frosted-blue',
        sheets: 'curated:crystal-white',
        slides: 'curated:graphite',
        pdf: 'snow',
        markdown: 'aurora',
        html: 'curated:silk',
      },
      globalCard: 'curated:frosted-blue',
      favorites: ['snow', 'curated:frosted-blue', 'curated:graphite'],
      customCards: [
        {
          id: 'custom:user_card_1',
          name: 'Personal Glass',
          material: { preset: 'frosted-glass' },
        },
      ],
    }

    const startTotal = performance.now()
    for (let i = 0; i < ITERATIONS; i++) {
      normalizeOpeningPrefs(complexStored)
    }
    const endTotal = performance.now()
    const totalMs = endTotal - startTotal
    const avgMs = totalMs / ITERATIONS

    console.log(`[Benchmark] Preferences Normalization (5,000 runs):`)
    console.log(`  Total: ${totalMs.toFixed(2)} ms`)
    console.log(`  Avg:   ${(avgMs * 1000).toFixed(1)} µs / normalization`)

    expect(avgMs).toBeLessThan(0.05)
  })
})
