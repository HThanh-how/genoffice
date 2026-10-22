import { describe, expect, it } from 'vitest'
import {
  appsShuffling,
  builtInGroupOf,
  chooseOpeningCardId,
  groupOf,
  pickRandomCard,
  randomCandidates,
  randomPoolFor,
  visibleGroupIds,
} from '../src/shared/opening-card-groups'
import { getAllBuiltInCards } from '../src/shared/opening-card-families'
import {
  DEFAULT_OPENING_PREFS,
  DEFAULT_SCENE_FOR_APP,
  OPENING_APPS,
  normalizeOpeningPrefs,
  resolveEffectiveOpeningCard,
  type OpeningApp,
  type OpeningPrefs,
} from '../src/shared/opening-scenes-meta'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'
import {
  appliesTo,
  appsUsingCard,
  effectiveCardId,
  isShuffling,
  orderInUseFirst,
} from '../src/renderer/src/fork/opening-card/studio-logic'

const all = getAllBuiltInCards() as OpeningCardDefinition[]
const prefs = (extra: Partial<OpeningPrefs> = {}): OpeningPrefs => ({
  ...DEFAULT_OPENING_PREFS,
  ...extra,
})
/** a random source that walks through fixed values */
const sequence = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]!
}

const mine: OpeningCardDefinition = {
  id: 'custom:mine',
  name: 'Mine',
  category: 'custom',
  contentKind: 'curated-material',
  material: { preset: 'solid' },
  isBuiltIn: false,
}

describe('groups', () => {
  it('puts every built-in card in exactly one group, materials apart from scenes', () => {
    for (const card of all) {
      const id = builtInGroupOf(card)
      expect(['materials', 'nature', 'sky', 'night', 'space', 'abstract']).toContain(id)
    }
    expect(builtInGroupOf(all.find((c) => c.id === 'curated:silk')!)).toBe('materials')
    expect(builtInGroupOf(all.find((c) => c.id === 'jungle')!)).toBe('nature')
    expect(builtInGroupOf(mine)).toBe('mine')
  })

  it('lets the person move a card into a group of their own, and falls back when that group is gone', () => {
    const p = prefs({ groups: [{ id: 'grp_a', name: 'Work' }], cardGroups: { jungle: 'grp_a' } })
    const jungle = all.find((c) => c.id === 'jungle')!
    expect(groupOf(jungle, p)).toBe('grp_a')
    expect(groupOf(jungle, prefs({ cardGroups: { jungle: 'grp_gone' } }))).toBe('nature')
  })

  it('lists the groups that hold cards, then the ones the person made, empty or not', () => {
    const ids = visibleGroupIds(all, prefs({ groups: [{ id: 'grp_a', name: 'Work' }] }))
    expect(ids.at(-1)).toBe('grp_a')
    expect(ids).not.toContain('mine')
    expect(visibleGroupIds([...all, mine], prefs())).toContain('mine')
  })
})

describe('the pool of random mode', () => {
  it('is every card that is not in the trash when no group is named', () => {
    const pool = randomCandidates(all, prefs({ removedCards: ['ocean'] }), {
      groups: [],
      starredOnly: false,
    })
    expect(pool).toHaveLength(all.length - 1)
    expect(pool.some((c) => c.id === 'ocean')).toBe(false)
  })

  it('is the union of the groups named, several at once', () => {
    const p = prefs()
    const nature = randomCandidates(all, p, { groups: ['nature'], starredOnly: false })
    const both = randomCandidates(all, p, { groups: ['nature', 'materials'], starredOnly: false })
    expect(nature.length).toBeGreaterThan(0)
    expect(nature.every((c) => builtInGroupOf(c) === 'nature')).toBe(true)
    expect(both.length).toBe(
      nature.length + all.filter((c) => builtInGroupOf(c) === 'materials').length,
    )
  })

  it('can be only the starred cards, inside the groups chosen', () => {
    const p = prefs({ favorites: ['jungle', 'ocean', 'galaxy'] })
    expect(
      randomCandidates(all, p, { groups: [], starredOnly: true })
        .map((c) => c.id)
        .sort(),
    ).toEqual(['galaxy', 'jungle', 'ocean'])
    expect(
      randomCandidates(all, p, { groups: ['nature'], starredOnly: true })
        .map((c) => c.id)
        .sort(),
    ).toEqual(['jungle', 'ocean'])
  })

  it('never offers a removed card, even a starred one in a chosen group', () => {
    const p = prefs({ favorites: ['jungle'], removedCards: ['jungle'] })
    expect(randomCandidates(all, p, { groups: ['nature'], starredOnly: true })).toEqual([])
  })

  it('follows a card into the group it was moved to', () => {
    const p = prefs({ groups: [{ id: 'grp_a', name: 'Work' }], cardGroups: { jungle: 'grp_a' } })
    expect(randomCandidates(all, p, { groups: ['grp_a'], starredOnly: false })).toHaveLength(1)
    expect(
      randomCandidates(all, p, { groups: ['nature'], starredOnly: false }).some(
        (c) => c.id === 'jungle',
      ),
    ).toBe(false)
  })
})

describe('drawing a card', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('draws by the random number, from the whole pool', () => {
    expect(pickRandomCard(pool, undefined, () => 0)?.id).toBe('a')
    expect(pickRandomCard(pool, undefined, () => 0.5)?.id).toBe('b')
    expect(pickRandomCard(pool, undefined, () => 0.999)?.id).toBe('c')
  })

  it('does not repeat the previous card while there is another', () => {
    for (const last of ['a', 'b', 'c']) {
      for (let i = 0; i < 200; i++) {
        expect(pickRandomCard(pool, last)?.id).not.toBe(last)
      }
    }
    // only one card: it has to repeat
    expect(pickRandomCard([{ id: 'a' }], 'a')?.id).toBe('a')
    expect(pickRandomCard([], 'a')).toBeUndefined()
  })

  it('reaches every card of the pool over many draws', () => {
    const seen = new Set<string>()
    let last: string | undefined
    for (let i = 0; i < 300; i++) {
      last = pickRandomCard(pool, last)!.id
      seen.add(last)
    }
    expect(seen.size).toBe(3)
  })
})

describe('which apps draw at random', () => {
  const pool = { groups: ['nature'], starredOnly: false }

  it('lets a setting for an app win over the one for all apps', () => {
    const p = prefs({ random: { all: pool, docs: { groups: [], starredOnly: true } } })
    expect(randomPoolFor(p, 'docs')?.starredOnly).toBe(true)
    expect(randomPoolFor(p, 'sheets')).toEqual(pool)
  })

  it('lets a card chosen for an app win over a random choice for all apps', () => {
    const p = prefs({ random: { all: pool }, appOverrides: { pdf: 'ocean' } })
    expect(randomPoolFor(p, 'pdf')).toBeUndefined()
    expect(appsShuffling(p)).toEqual(['docs', 'sheets', 'slides', 'markdown', 'html'])
    // ... and "inherit" is not a choice
    expect(
      randomPoolFor(prefs({ random: { all: pool }, appOverrides: { pdf: 'inherit' } }), 'pdf'),
    ).toEqual(pool)
  })

  it('draws a different card on each open, and remembers it per app', () => {
    const p = prefs({ random: { all: { groups: ['sky'], starredOnly: false } } })
    const memory = new Map<OpeningApp, string>()
    let last = ''
    for (let i = 0; i < 60; i++) {
      const id = chooseOpeningCardId(p, 'docs', undefined, memory)
      expect(builtInGroupOf(all.find((c) => c.id === id)!)).toBe('sky')
      expect(id).not.toBe(last)
      last = id
    }
    expect(memory.get('docs')).toBe(last)
    expect(memory.has('sheets')).toBe(false)
  })

  it('plays what a preview asks for, and the fixed card of an app that is not random', () => {
    const memory = new Map<OpeningApp, string>()
    const p = prefs({
      random: { docs: { groups: [], starredOnly: false } },
      appOverrides: { sheets: 'ocean' },
    })
    expect(chooseOpeningCardId(p, 'docs', 'lotus', memory)).toBe('lotus')
    expect(chooseOpeningCardId(p, 'sheets', undefined, memory)).toBe('ocean')
    expect(chooseOpeningCardId(p, 'pdf', undefined, memory)).toBe(DEFAULT_SCENE_FOR_APP.pdf)
  })

  it('falls back to the fixed card when the pool is empty, so an app never opens with nothing', () => {
    const p = prefs({ random: { all: { groups: [], starredOnly: true } } })
    expect(chooseOpeningCardId(p, 'docs', undefined, new Map())).toBe(DEFAULT_SCENE_FOR_APP.docs)
  })

  it('uses the injected random source', () => {
    const p = prefs({ random: { all: { groups: ['space'], starredOnly: false } } })
    const a = chooseOpeningCardId(p, 'docs', undefined, new Map(), sequence(0))
    const b = chooseOpeningCardId(p, 'docs', undefined, new Map(), sequence(0.999))
    expect(a).not.toBe(b)
  })
})

describe('the trash', () => {
  it('stops a removed card from being played where it was chosen, falling back to the default', () => {
    const p = prefs({
      globalCard: 'ocean',
      appOverrides: { sheets: 'lotus' },
      removedCards: ['ocean', 'lotus'],
    })
    for (const app of OPENING_APPS) {
      expect(resolveEffectiveOpeningCard(p, app).id).toBe(DEFAULT_SCENE_FOR_APP[app])
    }
  })

  it('passes over a stock scene that was removed, and plays the next available one', () => {
    const p = prefs({ removedCards: [DEFAULT_SCENE_FOR_APP.docs] })
    const id = resolveEffectiveOpeningCard(p, 'docs').id
    expect(id).not.toBe(DEFAULT_SCENE_FOR_APP.docs)
    expect(p.removedCards).not.toContain(id)
  })

  it('is mirrored by the studio: a removed card is not "in use" and the default shows instead', () => {
    const p = prefs({ globalCard: 'ocean', removedCards: ['ocean'] })
    expect(effectiveCardId(p, 'docs')).toBe(DEFAULT_SCENE_FOR_APP.docs)
    expect(appsUsingCard(p, 'ocean')).toEqual([])
  })
})

describe('the studio, with random mode on', () => {
  const p = prefs({ random: { all: { groups: [], starredOnly: false } }, globalCard: 'ocean' })

  it('does not call a card "in use" for an app that draws at random', () => {
    expect(isShuffling(p, 'docs')).toBe(true)
    expect(appsUsingCard(p, 'ocean')).toEqual([])
    expect(appliesTo('all', p, 'ocean')).toBe(false)
    expect(appliesTo('docs', p, 'ocean')).toBe(false)
  })

  it('still counts the apps that were given a card of their own', () => {
    const q = prefs({
      random: { all: { groups: [], starredOnly: false } },
      appOverrides: { pdf: 'ocean' },
    })
    expect(appsUsingCard(q, 'ocean')).toEqual(['pdf'])
    expect(isShuffling(q, 'pdf')).toBe(false)
  })

  it('lists starred cards right after the ones in use', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
    const q = prefs({ globalCard: 'd', favorites: ['c'] })
    expect(orderInUseFirst(cards, q).map((c) => c.id)).toEqual(['d', 'c', 'a', 'b'])
  })
})

describe('what is saved', () => {
  it('reads settings saved before groups, trash and random existed as having none of them', () => {
    const old = normalizeOpeningPrefs({
      enabled: true,
      tier: 'auto',
      scenes: { docs: 'snow' },
      globalCard: 'ocean',
      favorites: ['lotus'],
    })
    expect(old.removedCards).toBeUndefined()
    expect(old.groups).toBeUndefined()
    expect(old.cardGroups).toBeUndefined()
    expect(old.random).toBeUndefined()
    expect(old.globalCard).toBe('ocean')
    expect(old.favorites).toEqual(['lotus'])
    expect(resolveEffectiveOpeningCard(old, 'docs').id).toBe('ocean')
  })

  it('keeps what the person set, and survives a save and a load', () => {
    const saved = normalizeOpeningPrefs({
      removedCards: ['ocean', 'ocean', 'curated:silk'],
      groups: [{ id: 'grp_a', name: '  Work  ' }],
      cardGroups: { jungle: 'grp_a' },
      random: {
        all: { groups: ['nature', 'grp_a'], starredOnly: true },
        pdf: { groups: [], starredOnly: false },
      },
    })
    expect(saved.removedCards).toEqual(['ocean', 'curated:silk'])
    expect(saved.groups).toEqual([{ id: 'grp_a', name: 'Work' }])
    expect(saved.cardGroups).toEqual({ jungle: 'grp_a' })
    expect(saved.random?.all).toEqual({ groups: ['nature', 'grp_a'], starredOnly: true })
    expect(saved.random?.pdf).toEqual({ groups: [], starredOnly: false })
    expect(normalizeOpeningPrefs(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })

  it('drops what makes no sense: unknown cards, groups that do not exist, scripts in a name', () => {
    const saved = normalizeOpeningPrefs({
      removedCards: ['nope', 42, 'custom'],
      groups: [
        { id: 'grp_a', name: '<script>x</script>' },
        { id: 'Bad Id', name: 'x' },
        { id: 'grp_b', name: 'Fine' },
        { id: 'grp_b', name: 'Twice' },
      ],
      cardGroups: { jungle: 'grp_missing', ocean: 'grp_b' },
      random: { all: { groups: 'nature', starredOnly: 'yes' }, nowhere: { groups: [] } },
    })
    expect(saved.removedCards).toBeUndefined()
    expect(saved.groups).toEqual([{ id: 'grp_b', name: 'Fine' }])
    expect(saved.cardGroups).toEqual({ ocean: 'grp_b' })
    expect(saved.random).toEqual({ all: { groups: [], starredOnly: false } })
  })

  it('caps the number of groups', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `grp_${i}`, name: `G${i}` }))
    expect(normalizeOpeningPrefs({ groups: many }).groups).toHaveLength(24)
  })
})
