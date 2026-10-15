/**
 * Recipient selection: filtering and sorting are views over the source rows,
 * never a rewrite of them. A recipient keeps its `id` for the life of the
 * session, so "export the selected recipients" always writes exactly the rows
 * the user ticked, regardless of what the picker is currently showing.
 */
import type { MailMergeFilter, MailMergeRecipient, MailMergeSource } from './types'

export const DEFAULT_FILTER: MailMergeFilter = {
  search: '',
  column: '',
  operator: 'contains',
  value: '',
  sortColumn: '',
  sortDir: 'asc',
}

function matches(recipient: MailMergeRecipient, filter: MailMergeFilter): boolean {
  if (filter.search.trim()) {
    const needle = filter.search.trim().toLowerCase()
    if (!Object.values(recipient.values).some((v) => v.toLowerCase().includes(needle))) return false
  }
  if (filter.column) {
    const value = (recipient.values[filter.column] ?? '').trim()
    switch (filter.operator) {
      case 'contains':
        if (!value.toLowerCase().includes(filter.value.trim().toLowerCase())) return false
        break
      case 'equals':
        if (value.toLowerCase() !== filter.value.trim().toLowerCase()) return false
        break
      case 'empty':
        if (value !== '') return false
        break
      case 'notempty':
        if (value === '') return false
        break
    }
  }
  return true
}

/** Visible recipients after search + column filter + sort. Originals untouched. */
export function visibleRecipients(source: MailMergeSource, filter: MailMergeFilter): MailMergeRecipient[] {
  const filtered = source.recipients.filter((r) => matches(r, filter))
  if (!filter.sortColumn) return filtered
  const dir = filter.sortDir === 'desc' ? -1 : 1
  return filtered
    .slice()
    .sort((a, b) => {
      const left = a.values[filter.sortColumn] ?? ''
      const right = b.values[filter.sortColumn] ?? ''
      const numeric = Number(left)
      const numericRight = Number(right)
      if (Number.isFinite(numeric) && Number.isFinite(numericRight) && left.trim() && right.trim()) {
        return (numeric - numericRight) * dir
      }
      return left.localeCompare(right, undefined, { numeric: true }) * dir
    })
}

export function selectedCount(source: MailMergeSource): number {
  return source.recipients.reduce((n, r) => n + (r.selected ? 1 : 0), 0)
}

/** The rows an export will actually run, in source order. */
export function exportRecipients(source: MailMergeSource, scope: 'selected' | 'all'): MailMergeRecipient[] {
  return scope === 'all' ? source.recipients : source.recipients.filter((r) => r.selected)
}

export function setSelected(source: MailMergeSource, ids: Set<number>, value: boolean): MailMergeSource {
  return {
    ...source,
    recipients: source.recipients.map((r) => (ids.has(r.id) ? { ...r, selected: value } : r)),
  }
}
