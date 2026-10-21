/**
 * Window event: carries the file-search query typed in the Home input to the Home file search.
 * `detail.q` is the query; an empty `q` from `source: 'dock'` ends the search the input started.
 */
export const HOME_SEARCH_EVENT = 'genoffice:home-search'

export interface HomeSearchDetail {
  q: string
  source?: 'dock'
}

/** Longest typed text still taken for a file search; more words than this reads as a question. */
const MAX_SEARCH_WORDS = 6

/**
 * The file-search query for what is typed in the Home input, or '' when it is not a search: too short,
 * an index order (run here), or a question (trailing "?"/"？" or a long sentence), which goes to AI.
 */
export function dockSearchQuery(text: string, isCommand: boolean): string {
  const q = text.trim()
  if (q.length < 2 || isCommand) return ''
  if (/[?？]\s*$/.test(q)) return ''
  if (q.split(/\s+/).length > MAX_SEARCH_WORDS) return ''
  return q
}

/** The create-document cards give way to the results while a search is on. */
export function showCreateCards(searchActive: boolean): boolean {
  return !searchActive
}

/** The model and usage row under the field gives way to the results while a search is on (kept mounted). */
export function showDockExtra(searchActive: boolean): boolean {
  return !searchActive
}

/**
 * The inline "↵ Ask AI" hint in the field: only while the text is a file search (`searchQuery` from
 * `dockSearchQuery`), since Enter is not obvious there. Empty text, questions and index orders hide it.
 */
export function showAskHint(searchQuery: string): boolean {
  return searchQuery.length > 0
}

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
