import { describe, expect, it } from 'vitest'
import {
  SPLASH_THEMES,
  chooseSplashTier,
  skeletonHtml,
  lighterRgbOf,
  openingPageHtml,
  openingWords,
  rgbOf,
} from '../src/main/fork/opening-window'

describe('the "Opening…" splash for a legacy file', () => {
  it('says what is happening, in Vietnamese or English', () => {
    expect(openingWords('vi', 'doc').title).toBe('Đang mở tài liệu…')
    expect(openingWords('en', 'ppt').title).toBe('Opening presentation…')
    // the shell's other languages keep English
    expect(openingWords('zh', 'doc')).toEqual(openingWords('en', 'doc'))
  })

  it('shows the file name and cannot be turned into markup by it', () => {
    const html = openingPageHtml(
      openingWords('en', 'doc'),
      '<img src=x onerror=alert(1)>.doc',
      'docs',
      'full',
    )
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.doc')
    expect(html).not.toContain('<img')
    // nothing can be loaded from outside the page
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('wears the colour and letter of the app that opens the file', () => {
    const docs = openingPageHtml(openingWords('vi', 'doc'), 'a.doc', 'docs', 'lite')
    const sheets = openingPageHtml(openingWords('vi', 'doc'), 'a.xls', 'sheets', 'lite')
    const slides = openingPageHtml(openingWords('vi', 'ppt'), 'a.ppt', 'slides', 'lite')
    expect(docs).toContain(`--accent:${SPLASH_THEMES.docs.color}`)
    expect(sheets).toContain(`--accent:${SPLASH_THEMES.sheets.color}`)
    expect(slides).toContain(`--accent:${SPLASH_THEMES.slides.color}`)
    expect(new Set(Object.values(SPLASH_THEMES).map((theme) => theme.color)).size).toBe(6)
    expect(docs).toContain('>W</div>')
    expect(slides).toContain('>P</div>')
  })

  it('runs the animated sea only on the richer tiers', () => {
    const page = (tier: 'full' | 'lite' | 'minimal') =>
      openingPageHtml(openingWords('en', 'doc'), 'a.doc', 'docs', tier)
    expect(page('full')).toContain('<script>')
    expect(page('lite')).toContain('<script>')
    expect(page('minimal')).not.toContain('<script>')
    expect(page('minimal')).toContain('data-tier="minimal"')
  })

  it('turns hex colours into canvas colours, and lighter ones for the glow', () => {
    expect(rgbOf('#2b7cd3')).toBe('43,124,211')
    expect(rgbOf('not a colour')).toBe('43,124,211')
    const lighter = lighterRgbOf('#000000').split(',').map(Number)
    expect(lighter.every((part) => part > 100 && part < 130)).toBe(true)
  })
})

describe('how rich the animation is for this machine', () => {
  const strong = { cores: 12, memoryGB: 32, onBattery: false }
  it('gives a strong plugged-in machine the full version', () => {
    expect(chooseSplashTier(strong)).toBe('full')
  })
  it('gives a lighter one on battery or with modest hardware', () => {
    expect(chooseSplashTier({ ...strong, onBattery: true })).toBe('lite')
    expect(chooseSplashTier({ ...strong, cores: 4 })).toBe('lite')
    expect(chooseSplashTier({ ...strong, memoryGB: 8 })).toBe('lite')
  })
  it('keeps a weak machine, or a person who asked for less motion, to the calm one', () => {
    expect(chooseSplashTier({ ...strong, cores: 2 })).toBe('minimal')
    expect(chooseSplashTier({ ...strong, memoryGB: 4 })).toBe('minimal')
    expect(chooseSplashTier({ ...strong, reducedMotion: true })).toBe('minimal')
  })
})

describe('one scene for each app', () => {
  it('has a drawn scene and a background for every scene on offer, and plays one per app', async () => {
    const {
      SCENES,
      DEFAULT_SCENE_FOR_APP: SCENE_FOR_APP,
      SCENE_LIB,
      sceneMeta,
    } = await import('../src/main/fork/opening-scenes')
    for (const scene of SCENES) {
      expect(SCENE_LIB).toContain(`scenes.${scene.id}={`)
      expect(scene.bg).toHaveLength(2)
    }
    for (const app of Object.keys(SPLASH_THEMES) as Array<keyof typeof SPLASH_THEMES>) {
      expect(SCENES.some((s) => s.id === SCENE_FOR_APP[app])).toBe(true)
      const html = openingPageHtml(openingWords('en', 'open'), 'f', app, 'full')
      expect(html).toContain(`data-app="${app}"`)
      expect(html).toContain(`data-scene="${SCENE_FOR_APP[app]}"`)
      expect(html).toContain(sceneMeta(SCENE_FOR_APP[app]).bg[0])
    }
  })

  it('can play any scene on any app when asked to', () => {
    const html = openingPageHtml(openingWords('en', 'open'), 'f', 'docs', 'lite', 'lotus')
    expect(html).toContain('data-scene="lotus"')
  })

  it('keeps the script free of template-literal syntax, which would break the page', async () => {
    const { SCENE_LIB, SCENE_BOOT } = await import('../src/main/fork/opening-scenes')
    for (const script of [SCENE_LIB, SCENE_BOOT]) {
      expect(script).not.toContain('${')
      expect(script).not.toContain('`')
    }
  })

  it('says "opening" for a plain open too', () => {
    expect(openingWords('vi', 'open').title).toBe('Đang mở…')
    expect(openingWords('en', 'open').title).toBe('Opening…')
  })
})

describe('the opening page over a tab is a small card, not a full-size scene', () => {
  it('puts the scene in a card on a plain backdrop, and keeps the small window as it was', () => {
    const card = openingPageHtml(
      openingWords('en', 'open'),
      'a.docx',
      'docs',
      'full',
      'ocean',
      'card',
    )
    expect(card).toContain('<body class="card"')
    expect(card).toContain('body.card .stage')
    expect(card).toContain('width:min(480px,86vw)')
    expect(card).toContain('--backdrop')
    const window = openingPageHtml(openingWords('en', 'open'), 'a.docx', 'docs', 'full', 'ocean')
    expect(window).not.toContain('class="card"')
    expect(window).toContain('<div class="stage">')
  })

  it('shows the scene, the badge and the file name inside the card', () => {
    const card = openingPageHtml(
      openingWords('vi', 'open'),
      'Báo cáo.docx',
      'docs',
      'lite',
      'snow',
      'card',
    )
    const stage = card.slice(card.indexOf('<div class="stage">'), card.indexOf('</div>\n<script>'))
    expect(stage).toContain('id="sea"')
    expect(stage).toContain('class="badge"')
    expect(stage).toContain('Báo cáo.docx')
  })
})

describe('the outline of the editor behind the card', () => {
  it('is drawn for every kind of file, hidden from screen readers, and different for each', () => {
    const apps = Object.keys(SPLASH_THEMES) as Array<keyof typeof SPLASH_THEMES>
    const outlines = apps.map((app) => skeletonHtml(app))
    for (const html of outlines) {
      expect(html).toContain('class="skel" aria-hidden="true"')
      expect(html).toContain('class="sk-tabs"')
      expect(html).toContain('class="sk-ribbon"')
    }
    expect(skeletonHtml('docs')).toContain('sk-page')
    expect(skeletonHtml('sheets')).toContain('sk-grid')
    expect(skeletonHtml('slides')).toContain('sk-slide')
    expect(skeletonHtml('pdf')).toContain('sk-thumb sk-tall')
    expect(skeletonHtml('markdown')).toContain('sk-split')
    expect(
      new Set([skeletonHtml('docs'), skeletonHtml('sheets'), skeletonHtml('slides')]).size,
    ).toBe(3)
  })

  it('is behind the card over a tab, with a shimmer that stops for reduced motion, and not in the small window', () => {
    const card = openingPageHtml(
      openingWords('en', 'open'),
      'a.xlsx',
      'sheets',
      'minimal',
      undefined,
      'card',
    )
    expect(card).toContain('class="skel"')
    expect(card).toContain('@keyframes shim')
    expect(card).toContain('prefers-reduced-motion:reduce){.sk{animation:none}')
    expect(card.indexOf('class="skel"')).toBeLessThan(card.indexOf('class="stage"'))
    const small = openingPageHtml(openingWords('en', 'open'), 'a.xlsx', 'sheets', 'minimal')
    expect(small).not.toContain('class="skel"')
  })
})
