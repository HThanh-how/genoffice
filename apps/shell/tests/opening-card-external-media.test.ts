import { describe, expect, it } from 'vitest'
import {
  createOpeningCardExportBundle,
  importCardsFromExportBundle,
  validateCardDefinition,
} from '../src/main/fork/opening-card-export'
import { normalizeOpeningPrefs } from '../src/shared/opening-scenes-meta'
import { openingPageHtml, openingPageParts, openingWords } from '../src/shared/opening-page'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'
import type { LiveBackgroundMedia } from '../src/shared/fork/live-background'

const card: OpeningCardDefinition = {
  id: 'custom:local',
  name: 'Local',
  category: 'media',
  contentKind: 'personal-media',
  material: { preset: 'solid' },
  mediaRef: { sourceKey: 'home' },
}
const media: LiveBackgroundMedia = {
  kind: 'video',
  url: 'genoffice-bg://home/main?v=1',
  posterUrl: 'genoffice-bg://home/poster?v=1',
  title: '',
  origin: 'file',
}

describe('opening card external media', () => {
  it('normalizes references without changing old cards or accepting paths', () => {
    const cards = normalizeOpeningPrefs({
      customCards: [
        card,
        { ...card, id: 'custom:bad', mediaRef: { sourceKey: '../secret' } },
        { ...card, id: 'custom:old', mediaRef: undefined },
      ],
    }).customCards!
    expect(cards[0]?.mediaRef).toEqual({ sourceKey: 'home' })
    expect(cards[1]?.mediaRef).toBeUndefined()
    expect(cards[2]?.mediaRef).toBeUndefined()
    expect(validateCardDefinition({ ...card, mediaRef: { sourceKey: 'C:/secret' } }).ok).toBe(false)
    expect(validateCardDefinition(card).card?.mediaRef).toEqual(card.mediaRef)
  })
  it('shows a poster before video, suppresses playback in minimal tier and previews', () => {
    const html = openingPageHtml(
      openingWords('en', 'open'),
      'a',
      'docs',
      'full',
      undefined,
      'card',
      card,
      undefined,
      media,
    )
    expect(html).toContain('img-src data: genoffice-bg:; media-src genoffice-bg:;')
    expect(html).toContain('class="external-poster"')
    expect(html).toContain('class="external-video"')
    expect(html).toContain("addEventListener('loadeddata'")
    expect(html).toContain("addEventListener('error'")
    const minimal = openingPageHtml(
      openingWords('en', 'open'),
      'a',
      'docs',
      'minimal',
      undefined,
      'card',
      card,
      undefined,
      media,
    )
    expect(minimal).toContain('class="external-poster"')
    expect(minimal).not.toContain('<video')
    const preview = openingPageParts(
      openingWords('en', 'open'),
      'a',
      'docs',
      'full',
      undefined,
      'card',
      card,
      undefined,
      'shadow',
      media,
    )
    expect(preview.bodyInner).not.toContain('<video')
    const hostile = openingPageHtml(
      openingWords('en', 'open'),
      'a',
      'docs',
      'full',
      undefined,
      'card',
      card,
      undefined,
      { ...media, url: 'file:///secret' },
    )
    expect(hostile).not.toContain('file:///secret')
    const image = openingPageHtml(
      openingWords('en', 'open'),
      'a',
      'docs',
      'full',
      undefined,
      'card',
      card,
      undefined,
      { ...media, kind: 'image' },
    )
    expect(image).toContain('class="external-poster"')
    expect(image).not.toContain('<video')
  })
  it('does not export or import cards that reference local sources', async () => {
    const bundle = createOpeningCardExportBundle([card], '.')
    expect(bundle.cards).toEqual([])
    const imported = await importCardsFromExportBundle(JSON.stringify([card]), '.', [])
    expect(imported.ok).toBe(false)
    expect(imported.importedCards).toEqual([])
  })
})
