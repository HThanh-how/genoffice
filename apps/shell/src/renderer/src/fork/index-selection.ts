/**
 * Picking files in a list the way a file manager does: Ctrl/Cmd+click toggles one file, Shift+click
 * picks everything between the last picked file and this one. Pure, so the rules can be tested.
 */

export type PickMode = 'toggle' | 'range'

export interface PickState {
  picked: ReadonlySet<number>
  /** the file the next range starts from */
  anchor: number | null
}

export const NOTHING_PICKED: PickState = { picked: new Set(), anchor: null }

/** The state after a click on `target`, in a list shown in the order `ordered`. */
export function pick(
  state: PickState,
  ordered: readonly number[],
  target: number,
  mode: PickMode,
): PickState {
  if (mode === 'range' && state.anchor !== null) {
    const from = ordered.indexOf(state.anchor)
    const to = ordered.indexOf(target)
    if (from !== -1 && to !== -1) {
      const [low, high] = from <= to ? [from, to] : [to, from]
      // the range is added to what was already picked (as in Explorer with Ctrl+Shift)
      const picked = new Set(state.picked)
      for (const id of ordered.slice(low, high + 1)) picked.add(id)
      return { picked, anchor: state.anchor }
    }
  }
  const picked = new Set(state.picked)
  if (picked.has(target)) picked.delete(target)
  else picked.add(target)
  return { picked, anchor: target }
}
