import type {
  IgnoreRule,
  IndexingPreset,
  IgnoreTestResult,
} from '../../../../shared/fork/document-index-api'
import type { RuleFilters, TestOutcome } from './policy-ui-types'

/**
 * A rule is editable only when it belongs to the user's custom policy.
 * .genofficeignore rules are managed by the file editor and preset behaviour
 * by preset toggles — row actions must never touch either.
 */
export function isEditableRule(rule: IgnoreRule): boolean {
  return rule.source === undefined || rule.source === 'user'
}

export function ruleSource(rule: IgnoreRule): 'user' | '.genofficeignore' | 'preset' {
  return rule.source ?? 'user'
}

/**
 * Pure rule filtering used by the Rules view. Source semantics are exact:
 * "Custom rules" must not admit preset or .genofficeignore rules.
 */
export function filterRules(rules: readonly IgnoreRule[], filters: RuleFilters): IgnoreRule[] {
  const query = filters.search.trim().toLowerCase()
  return rules.filter((rule) => {
    if (filters.action === 'allow' && rule.action !== 'allow') return false
    if (filters.action === 'ignore' && rule.action === 'allow') return false

    if (filters.scope === 'global' && rule.scope !== 'global') return false
    if (filters.scope !== 'all' && filters.scope !== 'global' && rule.scope !== filters.scope) {
      return false
    }

    const source = ruleSource(rule)
    if (filters.source !== 'all' && source !== filters.source) return false

    if (filters.state === 'enabled' && !rule.enabled) return false
    if (filters.state === 'disabled' && rule.enabled) return false

    if (query) {
      const haystack = `${rule.pattern}\n${rule.description ?? ''}\n${rule.scope}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, page), pages)
}

export function pageSlice(
  rules: readonly IgnoreRule[],
  page: number,
  pageSize: number,
): IgnoreRule[] {
  const start = (page - 1) * pageSize
  return rules.slice(start, start + pageSize)
}

export function toggleSelected(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/**
 * Selection is page-scoped: "Select all" only ever selects the visible page,
 * never a global count compared against a page length.
 */
export function pageSelectionIds(pageRules: readonly IgnoreRule[]): Set<string> {
  const ids = new Set<string>()
  for (const rule of pageRules) {
    if (isEditableRule(rule)) ids.add(rule.id)
  }
  return ids
}

/**
 * "Select all" on a page is a toggle. When every selectable row of the visible
 * page is already selected, clicking the header checkbox clears exactly those
 * rows and leaves selections made on other pages untouched. Read-only
 * (.genofficeignore / preset) rules are never part of the set.
 */
export function togglePageSelection(
  selected: Set<string>,
  pageIds: readonly string[],
): Set<string> {
  const next = new Set(selected)
  const alreadySelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  if (alreadySelected) {
    for (const id of pageIds) next.delete(id)
  } else {
    for (const id of pageIds) next.add(id)
  }
  return next
}

export function isPageFullySelected(
  selected: Set<string>,
  pageRules: readonly IgnoreRule[],
): boolean {
  const ids = pageSelectionIds(pageRules)
  if (ids.size === 0) return false
  for (const id of ids) {
    if (!selected.has(id)) return false
  }
  return true
}

export function selectedEditableCount(rules: readonly IgnoreRule[], selected: Set<string>): number {
  let count = 0
  for (const rule of rules) {
    if (selected.has(rule.id) && isEditableRule(rule)) count++
  }
  return count
}

export function presetStates(presets: readonly IndexingPreset[]): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const preset of presets) map[preset.id] = preset.enabled !== false
  return map
}

/**
 * Missing or malformed engine responses are an explicit error state.
 * Never default to "allowed" when the IPC call did not return a decision.
 */
export function classifyTestResult(result: IgnoreTestResult | null | undefined): TestOutcome {
  if (!result || typeof result.ignored !== 'boolean') return 'error'
  if (result.eligibility === 'unsupported') return 'unsupported'
  return result.ignored ? 'ignored' : 'allowed'
}

export function isDirtyDraft(current: string, original: string): boolean {
  return current !== original
}

/** Allow rules that point at credential-bearing locations need a warning. */
export function isSensitivePattern(pattern: string): boolean {
  return /(\.ssh|\.aws|\.gnupg|\.env|secrets|credentials|private)/i.test(pattern)
}

/** Short, stable label for a scope value in the table. */
export function scopeLabel(scope: string, strings: { scopeGlobal: string }): string {
  if (scope === 'global') return strings.scopeGlobal
  const parts = scope.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || scope
}

/**
 * The engine describes .genofficeignore rules with a redundant
 * ".genofficeignore (ignore) in <root>" string. The source badge and the scope
 * column already carry that information, so only real notes are shown.
 */
export function rowDescription(rule: IgnoreRule): string {
  const description = (rule.description ?? '').trim()
  if (!description) return ''
  if (rule.source === '.genofficeignore' && description.startsWith('.genofficeignore')) return ''
  return description
}
