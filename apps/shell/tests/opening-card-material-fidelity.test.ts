// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { validateAiCardSchema } from '../src/main/fork/opening-card-ai'
import { validateCardDefinition } from '../src/main/fork/opening-card-export'
import { buildMaterialCss, sanitizeMaterialExtras } from '../src/shared/opening-card-css'
import { CURATED_CARD_FAMILIES } from '../src/shared/opening-card-families'
import type { OpeningMaterialConfig } from '../src/shared/opening-card-types'
import { CardSurface } from '../src/renderer/src/fork/opening-card/CardSurface'
import { CardThumbnail } from '../src/renderer/src/fork/opening-card/CardThumbnail'

const LIGHT = { systemTheme: 'light' as const }
const DARK = { systemTheme: 'dark' as const }
const base: OpeningMaterialConfig = { preset: 'frosted-glass', themeMode: 'system' }

describe('material look refinements (CSS only, optional)', () => {
  it('leaves a material that sets none of them exactly as the preset made it', () => {
    const plain = buildMaterialCss(base, LIGHT)
    expect(plain.background).not.toContain('linear-gradient(1')
    expect(plain.background).toMatch(/^rgba\(/)
    expect(plain.keyframesCss).toBe('')
    expect(plain.animation).toBe('')
    expect(plain.inlineCss).not.toContain('ocs-card-breathe')
  })

  it('layers a tint wash over the surface', () => {
    const out = buildMaterialCss({ ...base, tint: '#b4a7ec', tintStrength: 0.4 }, LIGHT)
    expect(out.background).toContain('rgba(180, 167, 236, 0.4)')
    expect(out.background.endsWith(buildMaterialCss(base, LIGHT).background)).toBe(true)
  })

  it('draws a gradient, dimmer on a dark surface than on a light one', () => {
    const material = { ...base, gradient: { from: '#c8e0f6', to: '#d8c8ee', angle: 135 } }
    const light = buildMaterialCss(material, LIGHT).background
    const dark = buildMaterialCss(material, DARK).background
    expect(light).toContain('linear-gradient(135deg, rgba(200, 224, 246')
    expect(dark).toContain('linear-gradient(135deg, rgba(200, 224, 246')
    const alpha = (css: string) => Number(/rgba\(200, 224, 246, ([\d.]+)\)/.exec(css)![1])
    expect(alpha(dark)).toBeLessThan(alpha(light))
  })

  it('adds grain and sheen as CSS layers, no images', () => {
    const out = buildMaterialCss({ ...base, grain: 1, sheen: 1 }, LIGHT)
    expect(out.background).toContain('radial-gradient')
    expect(out.background).toContain('repeating-linear-gradient')
    expect(out.background).toContain('linear-gradient(115deg')
    expect(out.background).not.toMatch(/url\(/)
  })

  it('adds an edge highlight as inset strokes', () => {
    const plain = buildMaterialCss(base, DARK).boxShadow
    const edged = buildMaterialCss({ ...base, edgeHighlight: 1 }, DARK).boxShadow
    expect(edged.length).toBeGreaterThan(plain.length)
    expect(edged).toContain('inset 0 0 0 1px')
  })

  it('shadowStyle diffuse spreads two wide layers; flat removes the drop shadow', () => {
    const solid: OpeningMaterialConfig = {
      preset: 'solid',
      themeMode: 'light',
      shadowIntensity: 0.9,
    }
    const diffuse = buildMaterialCss({ ...solid, shadowStyle: 'diffuse' }, LIGHT).boxShadow
    expect(diffuse.match(/rgba\(24, 36, 64/g)).toHaveLength(2)
    expect(diffuse).toMatch(/\d{2,3}px/)
    expect(buildMaterialCss({ ...solid, shadowStyle: 'flat' }, LIGHT).boxShadow).toBe('none')
  })

  it('glow breathes through keyframes, but not under reduced motion, and never fights !important', () => {
    const out = buildMaterialCss({ ...base, themeMode: 'dark', glow: 0.8 }, DARK)
    expect(out.animation).toContain('ocs-card-breathe')
    expect(out.keyframesCss).toContain('@keyframes ocs-card-breathe')
    expect(out.inlineCss).toContain('prefers-reduced-motion: no-preference')
    expect(out.inlineCss).toMatch(/\.stage \{[^}]*box-shadow: [^;!]*;/)
  })

  it('drops invalid refinements from untrusted input', () => {
    expect(
      sanitizeMaterialExtras({
        tint: 'url(javascript:alert(1))',
        gradient: { from: '#fff', to: 'red' },
        sheen: 4,
        grain: 'a lot',
        glow: -1,
        shadowStyle: 'huge',
      }),
    ).toEqual({ sheen: 1, glow: 0 })
    expect(
      sanitizeMaterialExtras({
        tint: '#abcdef',
        tintStrength: 0.5,
        gradient: { from: '#112233', to: '#445566', angle: 400 },
        shadowStyle: 'diffuse',
      }),
    ).toEqual({
      tint: '#abcdef',
      tintStrength: 0.5,
      gradient: { from: '#112233', to: '#445566', angle: 360 },
      shadowStyle: 'diffuse',
    })
  })

  it('survives import validation and AI validation', () => {
    const imported = validateCardDefinition({
      id: 'custom:fidelity',
      name: 'Fidelity',
      category: 'custom',
      contentKind: 'curated-material',
      material: { preset: 'solid', tint: '#ecdcb8', grain: 0.9, shadowStyle: 'diffuse' },
    })
    expect(imported.ok).toBe(true)
    expect(imported.card?.material).toMatchObject({
      tint: '#ecdcb8',
      grain: 0.9,
      shadowStyle: 'diffuse',
    })
    const ai = validateAiCardSchema({
      name: 'Dusk',
      description: 'Soft dusk',
      material: { preset: 'frosted-glass', gradient: { from: '#112233', to: '#445566' } },
    })
    expect(ai.ok).toBe(true)
    expect(ai.card?.material.gradient).toEqual({ from: '#112233', to: '#445566' })
  })
})

describe('the curated cards look like their descriptions', () => {
  const claims: Array<[RegExp, (m: OpeningMaterialConfig) => boolean, string]> = [
    [/gradient/i, (m) => Boolean(m.gradient), 'gradient'],
    [/\b(tint|lavender)\b/i, (m) => Boolean(m.tint), 'tint'],
    [/grain|fibre|fiber/i, (m) => (m.grain ?? 0) > 0, 'grain'],
    [/band of (reflected )?light/i, (m) => (m.sheen ?? 0) > 0, 'sheen'],
    [/edge|luster|lustre/i, (m) => (m.edgeHighlight ?? 0) > 0, 'edgeHighlight'],
    [/diffused|hover/i, (m) => m.shadowStyle === 'diffuse', 'shadowStyle diffuse'],
    [/aura|breathe/i, (m) => (m.glow ?? 0) > 0, 'glow'],
  ]

  it.each(CURATED_CARD_FAMILIES.map((c) => [c.name, c] as const))(
    '%s renders what it says',
    (_name, card) => {
      for (const [pattern, holds, field] of claims) {
        if (pattern.test(card.description ?? '')) {
          expect(holds(card.material), `${card.name} promises ${field}`).toBe(true)
        }
      }
    },
  )

  it('renders twelve different looks in light and in dark', () => {
    for (const theme of [LIGHT, DARK]) {
      const looks = CURATED_CARD_FAMILIES.map((c) => {
        const out = buildMaterialCss(c.material, theme)
        return `${out.background}|${out.boxShadow}|${out.color}`
      })
      expect(new Set(looks).size).toBe(CURATED_CARD_FAMILIES.length)
    }
  })

  it('does not rely on separate thumbnail colors', () => {
    for (const card of CURATED_CARD_FAMILIES) expect(card.thumbnailColors).toBeUndefined()
  })
})

describe('gallery thumbnails are the preview in small', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  it('draws the same material surface as the preview, never thumbnailColors', async () => {
    const card = CURATED_CARD_FAMILIES.find((c) => c.id === 'curated:soft-lavender')!
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        createElement('div', null, [
          createElement(
            'section',
            { key: 'thumb', 'data-kind': 'thumb' },
            createElement(CardThumbnail, {
              card: { ...card, thumbnailColors: ['#ff0000', '#00ff00'] },
            }),
          ),
          createElement(
            'section',
            { key: 'preview', 'data-kind': 'preview' },
            createElement(CardSurface, {
              material: card.material,
              app: 'docs',
              lang: 'en',
              title: 'Opening document…',
            }),
          ),
        ]),
      )
    })
    const thumbCard = host.querySelector('[data-kind="thumb"] .ocs-surface-card') as HTMLElement
    const previewCard = host.querySelector('[data-kind="preview"] .ocs-surface-card') as HTMLElement
    expect(thumbCard).not.toBeNull()
    expect(previewCard).not.toBeNull()
    expect(thumbCard.getAttribute('style')).toBe(previewCard.getAttribute('style'))
    expect(host.querySelector('.ocs-thumb-mini-card')).toBeNull()
    expect(host.innerHTML).not.toContain('255, 0, 0')
    await act(async () => root.unmount())
    host.remove()
  })
})
