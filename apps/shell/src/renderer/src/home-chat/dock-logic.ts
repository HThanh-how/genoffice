/** Window event: carries a file-search query from the Home input to the Home file search. */
export const HOME_SEARCH_EVENT = 'genoffice:home-search'

export interface IndexBrief {
  percent: number | null
  waiting: number
  errors: number
  active: boolean
}

/** One index chip, shown only while indexing or when something failed (hidden when all is done). */
export function showIndexChip(brief: IndexBrief | null): brief is IndexBrief {
  return !!brief && (brief.active || brief.errors > 0)
}

/**
 * Quick suggestions, at most two. `list` is [recent files, index progress, retry errors]; the progress
 * question is the index chip's job, and "retry" is offered only when there are problems.
 */
export function pickSuggestions(list: readonly string[], brief: IndexBrief | null): string[] {
  const out: string[] = []
  if (list[0]) out.push(list[0])
  if (list[2] && (brief?.errors ?? 0) > 0) out.push(list[2])
  return out
}

/**
 * Whether the Home input may take focus on its own: never over a dialog, another field, a text
 * selection, or an open settings sheet.
 */
export function canAutofocusDock(doc: Document): boolean {
  if (doc.querySelector('[role="dialog"], [aria-modal="true"], dialog[open], .modal-overlay'))
    return false
  const el = doc.activeElement
  if (
    el instanceof HTMLElement &&
    el !== doc.body &&
    (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  )
    return false
  const selection = doc.getSelection?.()
  if (selection && !selection.isCollapsed && selection.toString().trim()) return false
  return true
}
