import { describe, expect, it } from 'vitest'
import {
  buildOpeningPage,
  openingPageHtml,
  openingWords,
  setOpeningConfig,
} from '../src/main/fork/opening-window'
import { getBuiltInCard } from '../src/shared/opening-card-families'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'

describe('Opening Card Studio: Card Rendering Engine', () => {
  it('renders a curated card with material CSS and without script overhead', () => {
    const card = getBuiltInCard('curated:frosted-blue')
    expect(card).toBeDefined()
    const html = openingPageHtml(
      openingWords('en', 'open'),
      'report.docx',
      'docs',
      'full',
      undefined,
      'card',
      card,
    )

    // Contains material styling
    expect(html).toContain('backdrop-filter: var(--card-filter')
    expect(html).toContain('--card-accent: #3a82ee')

    // Since contentKind is curated-material, canvas and RAF script are omitted (saving GPU / battery)
    expect(html).not.toContain('<canvas id="sea"')
    expect(html).not.toContain('window.GOScene')
    expect(html).toContain('img-src data:;')
  })

  it('renders personal media background with dimming overlay', () => {
    const customCard: OpeningCardDefinition = {
      id: 'custom:hero-photo',
      name: 'Hero Photo',
      category: 'custom',
      contentKind: 'personal-media',
      mediaAssetId: 'asset_123_456.png',
      mediaFit: 'cover',
      mediaDim: 0.35,
      material: {
        preset: 'solid',
        opacity: 0.9,
      },
    }
    const fakeDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const html = openingPageHtml(
      openingWords('vi', 'open'),
      'dulieu.xlsx',
      'sheets',
      'lite',
      undefined,
      'card',
      customCard,
      fakeDataUrl,
    )

    expect(html).toContain(
      "background-image: linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)), url('data:image/png;base64,",
    )
    expect(html).toContain('background-size: cover !important')
  })

  it('buildOpeningPage resolves cards via getBuiltInCard or customCards', () => {
    setOpeningConfig({
      prefs: () => ({
        enabled: true,
        tier: 'auto',
        scenes: {
          docs: 'curated:midnight-glass',
          sheets: 'snow',
          slides: 'sunrise',
          pdf: 'leaves',
          markdown: 'city',
          html: 'aurora',
        },
      }),
      customHtml: () => null,
    })

    const page = buildOpeningPage({
      fileName: 'doc.docx',
      lang: 'en',
      kind: 'open',
      app: 'docs',
    })

    expect(page).toContain('backdrop-filter: var(--card-filter')
    expect(page).toContain('--card-accent: #5374a8')
  })

  it('buildOpeningPage respects globalCard fallback', () => {
    setOpeningConfig({
      prefs: () => ({
        enabled: true,
        tier: 'auto',
        globalCard: 'curated:minimal-black',
        scenes: {} as any,
      }),
      customHtml: () => null,
    })

    const page = buildOpeningPage({
      fileName: 'test.md',
      lang: 'en',
      kind: 'open',
      app: 'markdown',
    })

    expect(page).toContain('color: var(--card-fg, #f3f5fa)')
  })
})
