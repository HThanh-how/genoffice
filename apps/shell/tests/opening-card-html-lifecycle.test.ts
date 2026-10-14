import { describe, expect, it } from 'vitest'
import { buildOpeningPage, setOpeningConfig } from '../src/main/fork/opening-window'
import { DEFAULT_OPENING_PREFS } from '../src/shared/opening-scenes-meta'
import type { OpeningCardDefinition, StoredHtmlAsset } from '../src/shared/opening-card-types'

describe('Opening Card Studio — HTML Card Lifecycle & Isolation', () => {
  const htmlCardId = 'custom:html_card_123'
  const htmlAssetId = 'html_1700000000000_abcdef0123456789.json'

  const sampleCard: OpeningCardDefinition = {
    id: htmlCardId,
    name: 'Liquid Glass Aurora',
    category: 'custom',
    contentKind: 'ai-html',
    htmlAssetId,
    material: {
      preset: 'liquid-glass',
      themeMode: 'dark',
      accentColor: '#38bdf8',
    },
  }

  const sampleHtmlAsset: StoredHtmlAsset = {
    assetId: htmlAssetId,
    html: '<div class="glass-card"><span class="title">{{title}}</span><span class="file">{{fileName}}</span><span class="app">{{appName}}</span></div>',
    css: '.glass-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(20px); border-radius: 16px; }',
  }

  it('renders isolated sandboxed host HTML document with CSP and substituted placeholders', () => {
    setOpeningConfig({
      prefs: () => ({
        ...DEFAULT_OPENING_PREFS,
        globalCard: htmlCardId,
        customCards: [sampleCard],
      }),
      customHtml: () => null,
      htmlCardContent: (id) => (id === htmlAssetId ? sampleHtmlAsset : null),
    })

    const html = buildOpeningPage({
      fileName: 'Project_Alpha <script>alert(1)</script>.docx',
      lang: 'en',
      kind: 'open',
      app: 'docs',
    })

    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('Project_Alpha &lt;script&gt;alert(1)&lt;/script&gt;.docx')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('.glass-card {')
    expect(html).toContain('backdrop-filter: blur(20px)')
  })

  it('enforces reduced motion rules when tier is minimal', () => {
    setOpeningConfig({
      prefs: () => ({
        ...DEFAULT_OPENING_PREFS,
        globalCard: htmlCardId,
        customCards: [sampleCard],
      }),
      customHtml: () => null,
      htmlCardContent: (id) => (id === htmlAssetId ? sampleHtmlAsset : null),
    })

    const html = buildOpeningPage({
      fileName: 'Doc.docx',
      lang: 'en',
      kind: 'open',
      app: 'docs',
      forceTier: 'minimal',
    })

    expect(html).toContain('animation-duration: 0.001ms !important')
  })

  it('injects skeleton placeholder when layout is card', () => {
    setOpeningConfig({
      prefs: () => ({
        ...DEFAULT_OPENING_PREFS,
        globalCard: htmlCardId,
        customCards: [sampleCard],
      }),
      customHtml: () => null,
      htmlCardContent: (id) => (id === htmlAssetId ? sampleHtmlAsset : null),
    })

    const html = buildOpeningPage({
      fileName: 'Doc.docx',
      lang: 'en',
      kind: 'open',
      app: 'docs',
      layout: 'card',
    })

    expect(html).toContain('class="card-layout"')
    expect(html).toContain('class="skel"')
  })

  it('gracefully falls back to declarative material card if HTML asset is missing from disk', () => {
    setOpeningConfig({
      prefs: () => ({
        ...DEFAULT_OPENING_PREFS,
        globalCard: htmlCardId,
        customCards: [sampleCard],
      }),
      customHtml: () => null,
      htmlCardContent: () => null, // Asset missing
    })

    const html = buildOpeningPage({
      fileName: 'Report.docx',
      lang: 'en',
      kind: 'open',
      app: 'docs',
    })

    // Does not throw, renders standard opening page fallback with material styling
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Report.docx')
    expect(html).toContain('--card-accent: #38bdf8')
    expect(html).toContain('data-scene="custom:html_card_123"')
  })
})
