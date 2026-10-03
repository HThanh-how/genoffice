import { afterEach, describe, expect, it } from 'vitest'
import {
  CUSTOM_SCENE,
  DEFAULT_OPENING_PREFS,
  DEFAULT_SCENE_FOR_APP,
  OPENING_APPS,
  SCENES,
  normalizeOpeningPrefs,
} from '../src/shared/opening-scenes-meta'
import {
  buildOpeningPage,
  customPageHtml,
  openingEnabled,
  setOpeningConfig,
} from '../src/main/fork/opening-window'

afterEach(() => setOpeningConfig({ prefs: () => DEFAULT_OPENING_PREFS, customHtml: () => null }))

describe('the choices about opening scenes', () => {
  it('starts with the scenes picked for each app', () => {
    expect(DEFAULT_SCENE_FOR_APP).toEqual({
      docs: 'snow',
      sheets: 'jungle',
      slides: 'sunrise',
      pdf: 'leaves',
      markdown: 'city',
      html: 'aurora',
    })
    expect(normalizeOpeningPrefs(undefined)).toEqual(DEFAULT_OPENING_PREFS)
  })

  it('has a distinct id for every scene, and defaults that exist', () => {
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length)
    for (const app of OPENING_APPS) {
      expect(SCENES.some((s) => s.id === DEFAULT_SCENE_FOR_APP[app])).toBe(true)
    }
  })

  it('keeps what is valid and falls back for the rest, however the file was edited', () => {
    const prefs = normalizeOpeningPrefs({
      enabled: false,
      tier: 'lite',
      scenes: { docs: 'ocean', sheets: 'no-such-scene', slides: CUSTOM_SCENE, pdf: 42 },
    })
    expect(prefs.enabled).toBe(false)
    expect(prefs.tier).toBe('lite')
    expect(prefs.scenes.docs).toBe('ocean')
    expect(prefs.scenes.sheets).toBe(DEFAULT_SCENE_FOR_APP.sheets)
    expect(prefs.scenes.slides).toBe(CUSTOM_SCENE)
    expect(prefs.scenes.pdf).toBe(DEFAULT_SCENE_FOR_APP.pdf)
    expect(normalizeOpeningPrefs({ tier: 'weird' }).tier).toBe('auto')
    expect(normalizeOpeningPrefs('junk')).toEqual(DEFAULT_OPENING_PREFS)
  })
})

describe('the page that plays while a file opens', () => {
  it('plays the chosen scene for the app, and a given one for a preview', () => {
    setOpeningConfig({
      prefs: () => ({
        ...DEFAULT_OPENING_PREFS,
        scenes: { ...DEFAULT_SCENE_FOR_APP, docs: 'ocean' },
      }),
      customHtml: () => null,
    })
    const page = (scene?: string) =>
      buildOpeningPage({ fileName: 'a.docx', lang: 'en', kind: 'open', app: 'docs', scene })
    expect(page()).toContain('data-scene="ocean"')
    expect(page('lotus')).toContain('data-scene="lotus"')
  })

  it('fixes the richness when the person asked for it', () => {
    setOpeningConfig({
      prefs: () => ({ ...DEFAULT_OPENING_PREFS, tier: 'minimal' }),
      customHtml: () => null,
    })
    const page = buildOpeningPage({ fileName: 'a.docx', lang: 'en', kind: 'open', app: 'docs' })
    expect(page).toContain('data-tier="minimal"')
    expect(page).not.toContain('<script>')
  })

  it('reports whether the scene is switched on', () => {
    setOpeningConfig({
      prefs: () => ({ ...DEFAULT_OPENING_PREFS, enabled: false }),
      customHtml: () => null,
    })
    expect(openingEnabled()).toBe(false)
  })

  it('plays the imported page, and the ordinary scene when that page is gone', () => {
    const base = {
      prefs: () => ({
        ...DEFAULT_OPENING_PREFS,
        scenes: { ...DEFAULT_SCENE_FOR_APP, sheets: CUSTOM_SCENE },
      }),
    }
    setOpeningConfig({ ...base, customHtml: () => '<body>{{fileName}}</body>' })
    const own = buildOpeningPage({ fileName: 'Bảng.xlsx', lang: 'vi', kind: 'open', app: 'sheets' })
    expect(own).toContain('Bảng.xlsx')
    expect(own).not.toContain('data-scene=')
    setOpeningConfig({ ...base, customHtml: () => null })
    const fallback = buildOpeningPage({
      fileName: 'x.xlsx',
      lang: 'vi',
      kind: 'open',
      app: 'sheets',
    })
    expect(fallback).toContain('data-scene="jungle"')
  })
})

describe('a page the person imported', () => {
  const info = {
    fileName: 'a.docx',
    title: 'Opening…',
    hint: 'Wait',
    app: 'docs' as const,
    color: '#2b7cd3',
  }

  it('cannot reach the network, and the restriction comes before anything of theirs', () => {
    const html = customPageHtml('<html><head><title>x</title></head><body>hi</body></html>', info)
    expect(html.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/connect-src|img-src https?:/)
  })

  it('keeps their doctype first so the page is not thrown into quirks mode', () => {
    const html = customPageHtml('<!DOCTYPE html><html><body>hi</body></html>', info)
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(html.indexOf('<!DOCTYPE html>'))
  })

  it('fills in the file name safely and hands the data to scripts without letting it close the tag', () => {
    const html = customPageHtml('<p>{{fileName}} / {{ title }}</p>', {
      ...info,
      fileName: '<img src=x onerror=alert(1)>.docx',
    })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.docx / Opening…')
    expect(html).not.toContain('<img src=x')
    const script = /<script>window\.GENOFFICE_OPEN=(.*?)<\/script>/.exec(html)![1]!
    expect(JSON.parse(script).fileName).toBe('<img src=x onerror=alert(1)>.docx')
    expect(script).not.toContain('<')
  })

  it('does not take a page larger than the limit', () => {
    const big = 'x'.repeat(600 * 1024)
    expect(customPageHtml(big, info).length).toBeLessThan(540 * 1024)
  })
})
