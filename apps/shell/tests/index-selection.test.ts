import { describe, expect, it } from 'vitest'
import { NOTHING_PICKED, pick } from '../src/renderer/src/fork/index-selection'

const ordered = [10, 11, 12, 13, 14, 15]
const ids = (state: { picked: ReadonlySet<number> }) => [...state.picked].sort((a, b) => a - b)

describe('picking files like a file manager', () => {
  it('Ctrl+click adds a file and clicking it again removes it', () => {
    let state = pick(NOTHING_PICKED, ordered, 12, 'toggle')
    state = pick(state, ordered, 14, 'toggle')
    expect(ids(state)).toEqual([12, 14])
    state = pick(state, ordered, 12, 'toggle')
    expect(ids(state)).toEqual([14])
    expect(state.anchor).toBe(12)
  })

  it('Shift+click picks everything between the last picked file and this one, either way', () => {
    const start = pick(NOTHING_PICKED, ordered, 12, 'toggle')
    expect(ids(pick(start, ordered, 15, 'range'))).toEqual([12, 13, 14, 15])
    expect(ids(pick(start, ordered, 10, 'range'))).toEqual([10, 11, 12])
  })

  it('keeps what was picked before and the same anchor after a range', () => {
    let state = pick(NOTHING_PICKED, ordered, 10, 'toggle')
    state = pick(state, ordered, 13, 'toggle')
    state = pick(state, ordered, 15, 'range')
    expect(ids(state)).toEqual([10, 13, 14, 15])
    expect(state.anchor).toBe(13)
  })

  it('treats Shift+click with nothing picked yet as a plain pick', () => {
    expect(ids(pick(NOTHING_PICKED, ordered, 13, 'range'))).toEqual([13])
  })

  it('does not range from a file that is no longer in the list', () => {
    const state = { picked: new Set([99]), anchor: 99 }
    expect(ids(pick(state, ordered, 12, 'range'))).toEqual([12, 99])
  })
})
