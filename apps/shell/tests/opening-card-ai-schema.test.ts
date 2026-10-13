import { describe, expect, it } from 'vitest'
import {
  buildTextToCardPrompt,
  parseAiJsonPayload,
  validateAiCardSchema,
} from '../src/main/fork/opening-card-ai'

describe('Opening Card Studio: AI Schema Validation & Sanitization', () => {
  it('accepts valid declarative card configuration', () => {
    const input = {
      name: 'Nordic Mist',
      description: 'Serene cool blue frosted glass with subtle cyan border',
      preset: 'frosted-glass',
      themeMode: 'system',
      opacity: 0.82,
      blurPx: 24,
      accentColor: '#38bdf8',
      borderRadiusPx: 18,
      borderWidthPx: 1,
      shadowIntensity: 0.4,
    }
    const res = validateAiCardSchema(input)
    expect(res.ok).toBe(true)
    expect(res.card).toBeDefined()
    expect(res.card?.name).toBe('Nordic Mist')
    expect(res.card?.category).toBe('ai')
    expect(res.card?.contentKind).toBe('ai-declarative')
    expect(res.card?.material.preset).toBe('frosted-glass')
    expect(res.card?.material.accentColor).toBe('#38bdf8')
    expect(res.card?.material.blurPx).toBe(24)
  })

  it('rejects unauthorized extra fields to prevent injection', () => {
    const input = {
      name: 'Sneaky Card',
      preset: 'solid',
      maliciousField: 'payload',
    }
    const res = validateAiCardSchema(input)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Unauthorized field in AI output: maliciousField')
  })

  it('rejects HTML tags, script tags, and event handlers in text fields', () => {
    const attack1 = {
      name: '<script>alert(1)</script>',
      preset: 'solid',
    }
    expect(validateAiCardSchema(attack1).ok).toBe(false)

    const attack2 = {
      name: 'Clean Name',
      description: 'A card with <img src=x onerror=alert(1)> inside',
      preset: 'solid',
    }
    expect(validateAiCardSchema(attack2).ok).toBe(false)

    const attack3 = {
      name: 'javascript:void(0)',
      preset: 'solid',
    }
    expect(validateAiCardSchema(attack3).ok).toBe(false)
  })

  it('clamps out-of-range numerical values into safe bounds', () => {
    const input = {
      name: 'Boundary Test',
      preset: 'liquid-glass',
      opacity: -5, // Clamped to 0.1
      blurPx: 999, // Clamped to 48
      borderRadiusPx: 2, // Clamped to 8
      shadowIntensity: 5.0, // Clamped to 1.0
    }
    const res = validateAiCardSchema(input)
    expect(res.ok).toBe(true)
    expect(res.card?.material.opacity).toBe(0.1)
    expect(res.card?.material.blurPx).toBe(48)
    expect(res.card?.material.borderRadiusPx).toBe(8)
    expect(res.card?.material.shadowIntensity).toBe(1.0)
  })

  it('parses JSON payloads safely from raw output and markdown code fences', () => {
    const rawJson = '{"name": "Pure JSON", "preset": "solid"}'
    expect(parseAiJsonPayload(rawJson)).toEqual({ name: 'Pure JSON', preset: 'solid' })

    const fencedJson = '```json\n{"name": "Fenced", "preset": "frosted-glass"}\n```'
    expect(parseAiJsonPayload(fencedJson)).toEqual({ name: 'Fenced', preset: 'frosted-glass' })

    const textWithJson =
      'Here is your card:\n```\n{"name": "Embedded", "preset": "liquid-glass"}\n```\nHope you like it!'
    expect(parseAiJsonPayload(textWithJson)).toEqual({ name: 'Embedded', preset: 'liquid-glass' })
  })

  it('builds clean, constrained prompts for the AI model', () => {
    const prompt = buildTextToCardPrompt('Minimal dark obsidian card with purple glow')
    expect(prompt).toContain('GenOffice Opening Card Studio')
    expect(prompt).toContain('DO NOT include HTML')
    expect(prompt).toContain('Minimal dark obsidian card with purple glow')
  })
})
