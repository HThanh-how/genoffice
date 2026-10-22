import type { IndexedFolder } from '../../../shared/fork/document-index-api'
import type { EtaEstimate } from '../indexing-activity-model'
import { folderChips, folderDone } from './index-folder-status'
import type { IndexStatus, PauseWhy } from './index-status'

/**
 * Pure rules behind the Index screen: what the one status headline says, how the folder list is
 * ordered and filtered, and which rows of a long list are on screen. No React in here, so every
 * rule can be tested without drawing anything.
 */

/** The one sentence the screen opens with. */
export type HeadlineKind =
  | 'working'
  | 'scanning'
  | 'downloading'
  | 'modelError'
  | 'paused'
  | 'ready'
  | 'empty'

export interface Headline {
  kind: HeadlineKind
  /** why the work is held (only for 'paused') */
  why?: PauseWhy
  /** 0-100 when a real figure exists; null draws a bar without a fill ratio */
  percent: number | null
  /** searchable files and every file found, for the "x of y files" line */
  done: number
  total: number | null
  eta: EtaEstimate | null
}

export interface HeadlineInput {
  status: IndexStatus
  /** a folder is being scanned for files right now */
  scanning: boolean
  modelState: string
  modelProgress?: number
  /** files wait for the search model */
  pending: number
  hasFolders: boolean
  searchable: number
  total: number | null
}

export function deriveHeadline(input: HeadlineInput): Headline {
  const { status } = input
  const base = {
    percent: status.percent,
    done: input.searchable,
    total: input.total,
    eta: status.eta,
  }
  const paused = status.kind === 'paused'
  if (paused) return { kind: 'paused', ...(status.why ? { why: status.why } : {}), ...base }
  if (input.modelState === 'error') return { kind: 'modelError', ...base }
  if (input.modelState === 'downloading' && input.pending > 0) {
    const p = Math.round(Math.max(0, Math.min(1, input.modelProgress ?? 0)) * 100)
    return { kind: 'downloading', ...base, percent: p, eta: null }
  }
  if (input.scanning) return { kind: 'scanning', ...base, percent: null }
  if (status.kind === 'working') return { kind: 'working', ...base }
  if (!input.hasFolders && input.searchable === 0) return { kind: 'empty', ...base }
  return { kind: 'ready', ...base }
}

// ---- folders ----------------------------------------------------------------------------------

export type FolderRowState = 'ready' | 'indexing' | 'scanning' | 'stopped' | 'offline'

export interface FolderRow {
  root: string
  name: string
  state: FolderRowState
  done: number
  total: number
  errors: number
  priority: boolean
  /** the person added this folder themselves (a common place is switched off instead) */
  manual: boolean
  folder: IndexedFolder
}

export function folderName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1]! : root
}

/**
 * A long path keeps what a person recognises: where it starts and the last two folders. The full path
 * stays in the tooltip. "C:\Users\Linh\Work\2024\Contracts" becomes "C:\…\2024\Contracts".
 */
export function shortPath(path: string, max = 56): string {
  if (path.length <= max) return path
  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/).filter((part, i) => part || i === 0)
  if (parts.length <= 3) return path
  const head = parts[0] ?? ''
  return `${head}${sep}…${sep}${parts.slice(-2).join(sep)}`
}

/** Lower case with accents removed, so "tai lieu" finds "Tài liệu". */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
}

function stateOf(folder: IndexedFolder): FolderRowState {
  const chip = folderChips(folder)[0]
  switch (chip) {
    case 'offline':
      return 'offline'
    case 'scanning':
      return 'scanning'
    case 'stopped':
      return 'stopped'
    case 'indexing':
      return 'indexing'
    default:
      return 'ready'
  }
}

/** A folder that is first in the queue stays on top; the rest follow by name so rows never jump. */
export function toFolderRows(folders: readonly IndexedFolder[]): FolderRow[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return folders
    .map((folder): FolderRow => {
      const { done, total } = folderDone(folder)
      return {
        root: folder.root,
        name: folderName(folder.root),
        state: stateOf(folder),
        done,
        total,
        errors: Math.max(0, folder.errorFiles),
        priority: folder.priority,
        manual: !folder.owners || folder.owners.length === 0 || folder.owners.includes('manual'),
        folder,
      }
    })
    .sort(
      (a, b) =>
        Number(b.priority) - Number(a.priority) ||
        collator.compare(a.name, b.name) ||
        collator.compare(a.root, b.root),
    )
}

export function filterFolderRows(rows: readonly FolderRow[], query: string): FolderRow[] {
  const q = foldText(query)
  if (!q) return rows.slice()
  return rows.filter((row) => foldText(`${row.name} ${row.root}`).includes(q))
}

/** The filter box only appears once the list is long enough to need it. */
export const FILTER_FROM = 8

// ---- long lists -------------------------------------------------------------------------------

/** Rows above this count are drawn through a window; short lists are drawn whole. */
export const WINDOW_FROM = 60

export interface WindowInput {
  /** how far the top of the list has scrolled above the top of the viewport (negative: not yet) */
  scrolledPast: number
  viewport: number
  rowHeight: number
  count: number
  overscan?: number
}

/** The first and one-past-last row to draw. Always at least one row, never outside the list. */
export function windowRange(input: WindowInput): { start: number; end: number } {
  const { rowHeight, count } = input
  const overscan = input.overscan ?? 6
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor(input.scrolledPast / rowHeight)
  const visible = Math.ceil(Math.max(0, input.viewport) / rowHeight) + 1
  const start = Math.max(0, Math.min(count - 1, first - overscan))
  const end = Math.min(count, Math.max(start + 1, first + visible + overscan))
  return { start, end }
}
