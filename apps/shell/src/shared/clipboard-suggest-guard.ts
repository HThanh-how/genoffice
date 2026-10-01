import { CLIPBOARD_PREVIEW_MAX } from './clipboard-suggest-api'
import type { ClipboardSuggestion } from './clipboard-suggest-api'

const KINDS = new Set([
  'url',
  'longText',
  'shortText',
  'question',
  'paths',
  'table',
  'contact',
  'code',
])
const ACTIONS = new Set([
  'summarize',
  'translate',
  'rewrite',
  'ask',
  'findRelated',
  'analyze',
  'toSheet',
  'explainCode',
  'organize',
])

/** Validate an IPC payload before the renderer trusts it. */
export function isClipboardSuggestion(value: unknown): value is ClipboardSuggestion {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.kind === 'string' &&
    KINDS.has(v.kind) &&
    typeof v.preview === 'string' &&
    v.preview.length <= CLIPBOARD_PREVIEW_MAX &&
    typeof v.truncated === 'boolean' &&
    Array.isArray(v.actions) &&
    v.actions.length >= 1 &&
    v.actions.length <= 3 &&
    v.actions.every((a) => typeof a === 'string' && ACTIONS.has(a))
  )
}
