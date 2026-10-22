import { describe, expect, it } from 'vitest'
import { MATERIAL_TEXT, SCENE_TEXT, cardLabel } from '../src/shared/opening-card-text'
import { getAllBuiltInCards } from '../src/shared/opening-card-families'
import { SCENES } from '../src/shared/opening-scenes-meta'

describe('what the built-in cards say about themselves', () => {
  it('has a line in both languages for every scene and every material', () => {
    for (const scene of SCENES) {
      expect(SCENE_TEXT[scene.id]?.en, scene.id).toBeTruthy()
      expect(SCENE_TEXT[scene.id]?.vi, scene.id).toBeTruthy()
    }
    for (const id of Object.keys(MATERIAL_TEXT)) {
      const card = getAllBuiltInCards().find((c) => c.id === id)
      expect(card, id).toBeDefined()
      expect(MATERIAL_TEXT[id]!.nameVi).toBeTruthy()
      expect(MATERIAL_TEXT[id]!.vi).toBeTruthy()
    }
    expect(Object.keys(SCENE_TEXT).sort()).toEqual(SCENES.map((s) => s.id).sort())
  })

  it('keeps the stored description the English line, so searching and exports agree', () => {
    for (const card of getAllBuiltInCards()) {
      const label = cardLabel(card, 'en')
      expect(card.description, card.id).toBe(label.description)
    }
  })

  it('is short: one sentence of at most 130 characters', () => {
    for (const card of getAllBuiltInCards()) {
      for (const lang of ['en', 'vi']) {
        const { description } = cardLabel(card, lang)
        expect(description.length, `${card.id} ${lang}`).toBeLessThanOrEqual(130)
      }
    }
  })

  it('names a scene by what comes before the colon, in the language asked for', () => {
    const ocean = getAllBuiltInCards().find((c) => c.id === 'ocean')!
    expect(cardLabel(ocean, 'en').name).toBe('Ocean')
    expect(cardLabel(ocean, 'vi').name).toBe('Đại dương')
  })

  it("leaves a card of the person's own as they wrote it", () => {
    const own = { id: 'custom:x', name: 'Mine', description: 'My words' }
    expect(cardLabel(own, 'vi')).toEqual({ name: 'Mine', description: 'My words' })
  })
})
