import { describe, expect, it } from 'vitest'
import { buildMaterialCss, hexToRgb, sanitizeHexColor } from '../src/main/fork/opening-card-css'

describe('Opening Card Studio: Material System & Appearance Controls', () => {
  it('sanitizes hex color strings cleanly', () => {
    expect(sanitizeHexColor('#2b7cd3')).toBe('#2b7cd3')
    expect(sanitizeHexColor('#FFF')).toBe('#FFF')
    expect(sanitizeHexColor('invalid')).toBe('#2b7cd3')
    expect(sanitizeHexColor(undefined, '#123456')).toBe('#123456')
  })

  it('converts hex colors to RGB channels', () => {
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(hexToRgb('#2b7cd3')).toEqual({ r: 43, g: 124, b: 211 })
  })

  it('generates solid material with zero blur by default', () => {
    const res = buildMaterialCss({ preset: 'solid', themeMode: 'dark' })
    expect(res.backdropFilter).toBe('none')
    expect(res.background).toContain('rgba(24, 27, 34')
    expect(res.inlineCss).toContain('.stage {')
    expect(res.borderRadius).toBe('18px')
    expect(res.inlineCss).toContain('var(--card-radius, 18px)')
  })

  it('generates frosted glass with blur and saturation boost', () => {
    const res = buildMaterialCss({
      preset: 'frosted-glass',
      themeMode: 'dark',
      blurPx: 25,
      opacity: 0.8,
    })
    expect(res.backdropFilter).toContain('blur(25px)')
    expect(res.backdropFilter).toContain('saturate(140%)')
    expect(res.background).toContain('rgba(20, 25, 36, 0.8)')
  })

  it('generates liquid glass with gradient and high refraction', () => {
    const res = buildMaterialCss({
      preset: 'liquid-glass',
      themeMode: 'dark',
      blurPx: 30,
      opacity: 0.85,
    })
    expect(res.background).toContain('linear-gradient(135deg')
    expect(res.backdropFilter).toContain('blur(30px)')
    expect(res.backdropFilter).toContain('saturate(160%)')
  })

  it('generates minimal monochrome with neutral dark and light contrast', () => {
    const dark = buildMaterialCss({ preset: 'minimal-monochrome', themeMode: 'dark' })
    expect(dark.color).toBe('#f3f5fa')
    const light = buildMaterialCss({ preset: 'minimal-monochrome', themeMode: 'light' })
    expect(light.color).toBe('#181a1f')
    expect(light.background).toContain('250, 251, 253')
  })

  it('supports reduced transparency fallback for accessibility', () => {
    const res = buildMaterialCss({
      preset: 'frosted-glass',
      reduceTransparency: true,
      themeMode: 'dark',
    })
    expect(res.backdropFilter).toBe('none')
    expect(res.inlineCss).toContain('@media (prefers-reduced-transparency: reduce)')
    expect(res.inlineCss).toContain('backdrop-filter: none !important')
  })

  it('clamps extreme inputs into safe aesthetic ranges', () => {
    const res = buildMaterialCss({
      preset: 'frosted-glass',
      opacity: 9999, // Should clamp to 1.0
      blurPx: -500, // Should clamp to 0
      borderRadiusPx: 1000, // Should clamp to 36px
      shadowIntensity: -10, // Should clamp to 0
    })
    expect(res.background).toContain(', 1)')
    expect(res.borderRadius).toBe('36px')
    expect(res.backdropFilter).toBe('none') // blur is 0
  })

  it('includes media queries for system theme mode', () => {
    const res = buildMaterialCss({ preset: 'frosted-glass', themeMode: 'system' })
    expect(res.inlineCss).toContain('@media (prefers-color-scheme: light)')
    expect(res.inlineCss).toContain('@media (prefers-color-scheme: dark)')
  })
})
