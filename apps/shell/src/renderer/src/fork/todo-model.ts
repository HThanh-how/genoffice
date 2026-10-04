import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { isInformationalReason, isRetryableReason } from '../../../main/document-memory/issues'
import type { LegacyConvertState } from '../../../shared/home-api'

export function isLegacyConvertState(value: unknown): value is LegacyConvertState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<LegacyConvertState>
  return (
    typeof state.running === 'boolean' &&
    Number.isSafeInteger(state.pending) &&
    (state.pending as number) >= 0 &&
    Number.isSafeInteger(state.converted) &&
    (state.converted as number) >= 0 &&
    Number.isSafeInteger(state.failed) &&
    (state.failed as number) >= 0
  )
}

/** What the "To do" tab knows, gathered from the index, the scan, the converter and the indexing policy. */
export interface TodoInput {
  groups: ReadonlyArray<{ reason: IndexIssueReason; count: number }>
  /** files waiting to be read by the indexer */
  pending: number
  /** files ready to search */
  ready: number
  /** the person switched indexing off */
  switchedOff: boolean
  /** the indexing policy is holding the work back (battery, memory, a hot machine) */
  held: boolean
  heldReason?: string
  /** a folder is being scanned for files */
  scanning: boolean
  legacy: { running: boolean; pending: number; converted: number; failed: number } | null
}

export type TodoAction =
  | 'resume'
  | 'retryAll'
  | 'readScans'
  | 'convertNow'
  | 'viewErrors'
  | 'viewScans'
  | 'viewIndexing'
  | 'viewQuiet'

export interface TodoCard {
  id: 'off' | 'held' | 'errors' | 'scans' | 'legacy' | 'indexing' | 'scanning' | 'quiet'
  /** warn needs the person; info is the app working on its own; quiet is only for information */
  tone: 'warn' | 'info' | 'quiet'
  count: number
  primary?: TodoAction
  secondary?: TodoAction
  /** 0..100 when there is a real figure to show */
  progress?: number
  /** why, for a card that is the policy holding the work back */
  why?: string
  /** files that could not be converted (legacy card) */
  failed?: number
}

export interface TodoTile {
  id: 'indexing' | 'scans' | 'errors' | 'legacy' | 'ready'
  value: number
  /** highlight: there is something to do here */
  attention: boolean
  /** the list a click on the tile opens */
  opens?: TodoAction
}

export interface Todo {
  tiles: TodoTile[]
  cards: TodoCard[]
  /** nothing needs the person and nothing is in progress */
  healthy: boolean
}

const countOf = (input: TodoInput, pick: (reason: IndexIssueReason) => boolean): number =>
  input.groups.filter((g) => pick(g.reason)).reduce((total, g) => total + g.count, 0)

/** Cards in the order a person should look at them; only those that apply. */
export function buildTodo(input: TodoInput): Todo {
  const waiting = countOf(input, (r) => r === 'waiting')
  const scans = countOf(input, (r) => r === 'no-text')
  const failures = countOf(
    input,
    (r) => r !== 'no-text' && r !== 'waiting' && !isInformationalReason(r),
  )
  const retryable = input.groups.some(
    (g) =>
      g.count > 0 &&
      g.reason !== 'no-text' &&
      g.reason !== 'waiting' &&
      !isInformationalReason(g.reason) &&
      isRetryableReason(g.reason),
  )
  const quiet = countOf(input, (r) => r !== 'no-text' && isInformationalReason(r))
  const legacyPending = input.legacy?.pending ?? 0
  const indexing = Math.max(input.pending, waiting)

  const cards: TodoCard[] = []
  if (input.switchedOff) cards.push({ id: 'off', tone: 'warn', count: 0, primary: 'resume' })
  else if (input.held) {
    cards.push({
      id: 'held',
      tone: 'info',
      count: indexing,
      ...(input.heldReason ? { why: input.heldReason } : {}),
    })
  }
  if (failures > 0) {
    cards.push({
      id: 'errors',
      tone: 'warn',
      count: failures,
      ...(retryable ? { primary: 'retryAll' as const } : {}),
      secondary: 'viewErrors',
    })
  }
  if (scans > 0) {
    cards.push({
      id: 'scans',
      tone: 'warn',
      count: scans,
      primary: 'readScans',
      secondary: 'viewScans',
    })
  }
  if (input.legacy && (input.legacy.running || legacyPending > 0)) {
    const total = input.legacy.converted + legacyPending
    cards.push({
      id: 'legacy',
      tone: 'info',
      count: legacyPending,
      ...(total > 0 ? { progress: Math.round((input.legacy.converted / total) * 100) } : {}),
      ...(!input.legacy.running && legacyPending > 0 ? { primary: 'convertNow' as const } : {}),
      ...(input.legacy.failed > 0 ? { failed: input.legacy.failed } : {}),
    })
  }
  if (!input.held && !input.switchedOff && indexing > 0) {
    cards.push({
      id: 'indexing',
      tone: 'info',
      count: indexing,
      ...(waiting > 0 ? { secondary: 'viewIndexing' as const } : {}),
    })
  }
  if (input.scanning) cards.push({ id: 'scanning', tone: 'info', count: 0 })
  if (quiet > 0) cards.push({ id: 'quiet', tone: 'quiet', count: quiet, secondary: 'viewQuiet' })

  const tiles: TodoTile[] = [
    {
      id: 'indexing',
      value: indexing,
      attention: false,
      ...(waiting > 0 ? { opens: 'viewIndexing' as const } : {}),
    },
    {
      id: 'scans',
      value: scans,
      attention: scans > 0,
      ...(scans > 0 ? { opens: 'viewScans' as const } : {}),
    },
    {
      id: 'errors',
      value: failures,
      attention: failures > 0,
      ...(failures > 0 ? { opens: 'viewErrors' as const } : {}),
    },
    { id: 'legacy', value: legacyPending, attention: false },
    { id: 'ready', value: input.ready, attention: false },
  ]
  const healthy = cards.every((card) => card.tone === 'quiet')
  return { tiles, cards, healthy }
}

/** Lower case, without accents (and đ as d): "nam hoc" finds "Năm học". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
}

/** Every word typed must be somewhere in the file name or its folder. */
export function matchesQuery(item: { name: string; path: string }, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = fold(`${item.name} ${item.path}`)
  return words.every((word) => haystack.includes(word))
}
