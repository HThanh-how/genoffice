import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexFileDetail, IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { isRetryableReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { iconFor } from '../file-icons'
import { buildFileLog, deriveFileSteps, formatBytes, logWords } from './index-file-log'

/** What the indexer is doing with one file right now. */
export type Live =
  | { kind: 'reading'; since: number }
  | { kind: 'embedding'; done: number; total: number }
  | { kind: 'queued'; position: number }
  | { kind: 'paused' }

export function liveOf(now: IndexingNow | null, path: string): Live | null {
  if (!now) return null
  const reading = now.extracting.find((entry) => entry.path === path)
  if (reading) return { kind: 'reading', since: reading.since }
  const vectors = now.embedding[path]
  if (vectors) return { kind: 'embedding', done: vectors.done, total: vectors.total }
  if (now.paused) return { kind: 'paused' }
  const position = now.positions[path]
  return position ? { kind: 'queued', position } : null
}

/** What the indexer is doing, refreshed while a list is on screen. */
export function useIndexingNow(api: HomeApi, active: boolean): IndexingNow | null {
  const [now, setNow] = useState<IndexingNow | null>(null)
  useEffect(() => {
    if (!active || !api.getIndexingNow) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await api.getIndexingNow()
          if (alive) setNow(next)
        } catch {
          /* keep the last reading */
        }
      }
      if (alive) timer = setTimeout(() => void tick(), 1500)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [api, active])
  return now
}

const clock = (since: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What a row needs to know about a file, whichever list it comes from. */
export interface FileItem {
  id: number
  path: string
  name: string
  status?: string
  reason?: IndexIssueReason
  error?: string
  progress?: { kind: 'ocr' | 'chunks'; done: number; total: number }
}

const EN = {
  reading: 'Reading · {t}',
  embedding: 'Building search vectors {d}/{n}',
  queued: 'Next in line: {n}',
  pausedNow: 'Paused for now',
  done: 'Done',
  retry: 'Try again',
  readFirst: 'Read this one first',
  reread: 'Read again',
  readNow: 'Read with Antigravity now',
  copyLog: 'Copy log',
  copied: 'Log copied.',
  reveal: 'Show in folder',
  loading: 'Loading…',
  retriedOne: 'Queued for another try.',
  ocrConfirm:
    'Read this scanned PDF now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
  ocrDone: 'Read {n} pages. It is searchable shortly.',
  ocrFailed: 'Could not read: {e}',
  path: 'Path',
  okTag: 'Indexed',
}
export type FileWords = typeof EN
const VI: FileWords = {
  reading: 'Đang đọc · {t}',
  embedding: 'Đang lập vector tìm kiếm {d}/{n}',
  queued: 'Hàng chờ thứ {n}',
  pausedNow: 'Đang tạm dừng',
  done: 'Xong',
  retry: 'Thử lại',
  readFirst: 'Đọc tệp này trước',
  reread: 'Đọc lại',
  readNow: 'Đọc bằng Antigravity ngay',
  copyLog: 'Sao chép nhật ký',
  copied: 'Đã sao chép nhật ký.',
  reveal: 'Mở thư mục chứa tệp',
  loading: 'Đang tải…',
  retriedOne: 'Đã xếp lại để thử lần nữa.',
  ocrConfirm:
    'Đọc ngay tệp PDF quét này bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  ocrDone: 'Đã đọc {n} trang. Lát nữa là tìm được.',
  ocrFailed: 'Không đọc được: {e}',
  path: 'Đường dẫn',
  okTag: 'Đã index',
}
export const fileWords = (lang: string): FileWords => (lang === 'vi' ? VI : EN)

const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)
export const IRetry = () => (
  <Svg>
    <path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3" />
    <path d="M13.4 2.2v3h-3" />
  </Svg>
)
export const IChevron = () => (
  <Svg>
    <path d="M6 3.6 10.4 8 6 12.4" />
  </Svg>
)
const ICopy = () => (
  <Svg>
    <rect x="5.2" y="5.2" width="8" height="8" rx="1.6" />
    <path d="M10.8 5.2V3.8a1.4 1.4 0 0 0-1.4-1.4H3.8a1.4 1.4 0 0 0-1.4 1.4v5.6a1.4 1.4 0 0 0 1.4 1.4h1.4" />
  </Svg>
)
const IFolder = () => (
  <Svg>
    <path d="M2.2 4.6a1.4 1.4 0 0 1 1.4-1.4h2.5l1.4 1.6h4.9a1.4 1.4 0 0 1 1.4 1.4v5.2a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4z" />
  </Svg>
)
const ISpark = () => (
  <Svg>
    <path d="M8 1.8l1.4 4.1 4.1 1.4-4.1 1.4L8 12.8 6.6 8.7 2.5 7.3l4.1-1.4z" />
  </Svg>
)

export function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="ixp-icon"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Progress({ progress }: { progress: NonNullable<FileItem['progress']> }) {
  if (progress.total <= 0) return null
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100))
  return (
    <span
      className="ixp-progress"
      title={`${progress.done}/${progress.total}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
    >
      <span className="ixp-bar">
        <i style={{ width: `${Math.max(percent, 3)}%` }} />
      </span>
      <span className="ixp-progress-n">
        {progress.done}/{progress.total}
      </span>
    </span>
  )
}

/** Shared behaviour of every file list: open a file's log, copy it, retry, read now. */
export function useFileActions(
  api: HomeApi,
  reasonTitle: (reason: IndexIssueReason) => string,
  onChanged: () => void,
  afterChange: (item: FileItem) => Promise<void> | void,
) {
  const { lang, dateLocale } = useI18n()
  const w = fileWords(lang)
  const [open, setOpen] = useState<number | null>(null)
  const [details, setDetails] = useState<Record<number, IndexFileDetail | null>>({})
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const say = useCallback((text: string) => {
    setNote(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNote(''), 4000)
  }, [])

  const detailOf = async (id: number): Promise<IndexFileDetail | null> => {
    if (id in details) return details[id] ?? null
    try {
      const got = await api.getIndexFileDetail(id)
      setDetails((current) => ({ ...current, [id]: got }))
      return got
    } catch {
      return null
    }
  }
  const toggle = (item: FileItem) => {
    const next = open === item.id ? null : item.id
    setOpen(next)
    if (next !== null) void detailOf(next)
  }
  const withBusy = async (id: number, work: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(id))
    try {
      await work()
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }
  const settle = async (item: FileItem) => {
    setDetails({})
    await afterChange(item)
    onChanged()
  }
  const copyLog = async (item: FileItem) => {
    const detail = await detailOf(item.id)
    const text = detail
      ? buildFileLog(detail, lang, dateLocale, item.reason ? reasonTitle(item.reason) : undefined)
      : `${item.path}\n${item.error ?? ''}`
    try {
      await navigator.clipboard.writeText(text)
      say(w.copied)
    } catch {
      say(text)
    }
  }
  const retry = (item: FileItem) =>
    withBusy(item.id, async () => {
      const result = await api.retryDocumentIndex(item.id)
      say(result.ok ? w.retriedOne : fill(w.ocrFailed, { e: result.error ?? '' }))
      await settle(item)
    })
  const readNow = (item: FileItem) =>
    withBusy(item.id, async () => {
      if (!window.confirm(w.ocrConfirm)) return
      try {
        const result = await api.readScannedPdfWithAgy(item.id, true)
        say(
          result.ok
            ? fill(w.ocrDone, { n: result.pages ?? 0 })
            : fill(w.ocrFailed, { e: result.error ?? '' }),
        )
      } catch (error) {
        say(fill(w.ocrFailed, { e: error instanceof Error ? error.message : '' }))
      }
      await settle(item)
    })
  return { open, toggle, details, busy, note, say, copyLog, retry, readNow }
}

export type FileActions = ReturnType<typeof useFileActions>

/** One file: icon, name, cause, progress and icon actions; the name opens its log. */
export function FileRow({
  item,
  actions,
  api,
  status,
  live = null,
  finished = false,
}: {
  item: FileItem
  actions: FileActions
  api: HomeApi
  /** a short tag shown instead of the cause (search results) */
  status?: string
  /** what the indexer is doing with it now */
  live?: Live | null
  /** it has just been read: shown green for a moment, then removed by the list */
  finished?: boolean
}) {
  const { lang, dateLocale } = useI18n()
  const w = fileWords(lang)
  const lw = logWords(lang)
  const isOpen = actions.open === item.id
  const busy = actions.busy.has(item.id)
  const detail = actions.details[item.id]
  const retryable = item.reason ? isRetryableReason(item.reason) : false
  const liveText =
    live?.kind === 'reading'
      ? fill(w.reading, { t: clock(live.since) })
      : live?.kind === 'embedding'
        ? fill(w.embedding, { d: live.done, n: live.total })
        : live?.kind === 'queued'
          ? fill(w.queued, { n: live.position })
          : live?.kind === 'paused'
            ? w.pausedNow
            : ''
  const working = live?.kind === 'reading' || live?.kind === 'embedding'
  const progress =
    live?.kind === 'embedding'
      ? { kind: 'chunks' as const, done: live.done, total: live.total }
      : item.progress
  return (
    <li className={`${isOpen ? 'is-selected' : ''}${finished ? ' is-done' : ''}`}>
      <div className="ixp-row">
        <button
          type="button"
          className="ixp-main"
          aria-expanded={isOpen}
          onClick={() => actions.toggle(item)}
        >
          <span
            className={`ixp-icon-wrap${working ? ' is-working' : ''}${finished ? ' is-ok' : ''}`}
          >
            <img className="ixp-file-icon" src={iconFor(item.name)} alt="" width="18" height="18" />
            {finished && (
              <svg className="ixp-check" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="8" fill="currentColor" />
                <path
                  d="m4.6 8.2 2.3 2.3 4.5-4.8"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span className="ixp-file-text">
            <span className="ixp-file-name" title={item.path}>
              {item.name}
            </span>
            {(finished || liveText || status || item.error) && (
              <span className={`ixp-file-sub${working ? ' is-live' : ''}`}>
                {finished ? w.done : liveText || (status ?? item.error)}
              </span>
            )}
          </span>
        </button>
        {busy ? (
          <span className="ixp-spin" role="status" aria-label={w.loading} />
        ) : (
          progress && <Progress progress={progress} />
        )}
        <span className="ixp-actions">
          {item.reason === 'no-text' && (
            <IconButton
              label={w.readNow}
              disabled={busy}
              onClick={() => void actions.readNow(item)}
            >
              <ISpark />
            </IconButton>
          )}
          {(retryable || item.status === 'ready') && (
            <IconButton
              label={
                item.reason === 'waiting'
                  ? w.readFirst
                  : item.status === 'ready'
                    ? w.reread
                    : w.retry
              }
              disabled={busy}
              onClick={() => void actions.retry(item)}
            >
              <IRetry />
            </IconButton>
          )}
          <IconButton label={w.copyLog} onClick={() => void actions.copyLog(item)}>
            <ICopy />
          </IconButton>
          <IconButton label={w.reveal} onClick={() => void api.revealDocumentIndexFile(item.id)}>
            <IFolder />
          </IconButton>
        </span>
      </div>
      {isOpen &&
        (detail === undefined ? (
          <p className="ixp-loading">{w.loading}</p>
        ) : detail === null ? (
          <div className="ixp-detail">
            <code className="ixp-raw">{item.error ?? item.path}</code>
          </div>
        ) : (
          <div className="ixp-detail">
            <ol className="ixp-steps">
              {deriveFileSteps(detail, lang).map((step) => (
                <li key={step.key} className={`is-${step.state}`}>
                  <i aria-hidden="true" />
                  <span className="ixp-step-name">{lw[step.key]}</span>
                  <span className="ixp-step-text">{step.text}</span>
                </li>
              ))}
            </ol>
            <dl className="ixp-facts">
              <div>
                <dt>{w.path}</dt>
                <dd title={detail.path}>{detail.path}</dd>
              </div>
              {detail.sizeBytes !== undefined && (
                <div>
                  <dt>{lw.size}</dt>
                  <dd>{formatBytes(detail.sizeBytes, dateLocale)}</dd>
                </div>
              )}
              {detail.mtimeMs !== undefined && (
                <div>
                  <dt>{lw.modified}</dt>
                  <dd>{new Date(detail.mtimeMs).toLocaleString(dateLocale)}</dd>
                </div>
              )}
              <div>
                <dt>{lw.updated}</dt>
                <dd>{new Date(detail.updatedAt).toLocaleString(dateLocale)}</dd>
              </div>
            </dl>
            {detail.error && <code className="ixp-raw">{detail.error}</code>}
          </div>
        ))}
    </li>
  )
}
