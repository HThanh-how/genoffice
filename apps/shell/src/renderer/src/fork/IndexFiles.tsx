import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
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
  | { kind: 'reading'; since: number; pages?: { done: number; total: number } }
  | { kind: 'embedding'; done: number; total: number }
  | { kind: 'queued'; position: number; pages?: { done: number; total: number } }
  | { kind: 'paused' }

export function liveOf(now: IndexingNow | null, path: string): Live | null {
  if (!now) return null
  const pages = now.pages?.[path]
  const reading = now.extracting.find((entry) => entry.path === path)
  if (reading) return { kind: 'reading', since: reading.since, ...(pages ? { pages } : {}) }
  const vectors = now.embedding[path]
  if (vectors) return { kind: 'embedding', done: vectors.done, total: vectors.total }
  if (now.paused) return { kind: 'paused' }
  const position = now.positions[path]
  return position ? { kind: 'queued', position, ...(pages ? { pages } : {}) } : null
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

/** The folder a file is in, whichever separator the path uses. */
export const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

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
  readingPages: 'Reading · {t} · page {d}/{p}',
  queuedPages: 'Next in line: {n} · {d}/{p} pages read',
  embedding: 'Building search vectors {d}/{n}',
  queued: 'Next in line: {n}',
  pausedNow: 'Paused for now',
  done: 'Done',
  retry: 'Try again',
  readFirst: 'Read this one first',
  reread: 'Read again',
  readNow: 'Read with Antigravity now',
  readPicked: 'Index {n} selected files now',
  clearPicked: 'Clear selection',
  copyLog: 'Copy log',
  copied: 'Copied.',
  reveal: 'Show in folder',
  openFile: 'Open file',
  stop: 'Stop reading',
  later: 'Read later',
  deferred: 'Moved to the end of the line.',
  stopped: 'Stopped. Use Try again to read it later.',
  copyPath: 'Copy path',
  couldNotOpen: 'Could not open this file.',
  loading: 'Loading…',
  readDone: 'Read. It can be searched now.',
  readEmpty: 'Read, but there is no text in it: it is a scan. Use “Read with Antigravity”.',
  indexOff: 'Indexing is switched off. Turn it on in the index settings.',
  ocrConfirm:
    'Read this scanned PDF now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
  ocrIndexed: 'Its pages were already read; the text is in the index now.',
  ocrStarted: 'It is a scan: reading it with Antigravity…',
  ocrDone: 'Read {n} pages. It is searchable shortly.',
  ocrFailed: 'Could not read: {e}',
  path: 'Path',
  okTag: 'Indexed',
}
export type FileWords = typeof EN
const VI: FileWords = {
  reading: 'Đang đọc · {t}',
  readingPages: 'Đang đọc · {t} · trang {d}/{p}',
  queuedPages: 'Hàng chờ thứ {n} · đã đọc {d}/{p} trang',
  embedding: 'Đang lập vector tìm kiếm {d}/{n}',
  queued: 'Hàng chờ thứ {n}',
  pausedNow: 'Đang tạm dừng',
  done: 'Xong',
  retry: 'Thử lại',
  readFirst: 'Đọc tệp này trước',
  reread: 'Đọc lại',
  readNow: 'Đọc bằng Antigravity ngay',
  readPicked: 'Index {n} tệp đã chọn ngay',
  clearPicked: 'Bỏ chọn',
  copyLog: 'Sao chép nhật ký',
  copied: 'Đã sao chép.',
  reveal: 'Mở thư mục chứa tệp',
  openFile: 'Mở tệp',
  stop: 'Dừng đọc',
  later: 'Đọc sau',
  deferred: 'Đã đẩy xuống cuối hàng chờ.',
  stopped: 'Đã dừng. Bấm Thử lại để đọc sau.',
  copyPath: 'Sao chép đường dẫn',
  couldNotOpen: 'Không mở được tệp này.',
  loading: 'Đang tải…',
  readDone: 'Đã đọc xong, tìm được rồi.',
  readEmpty: 'Đã đọc nhưng không có chữ: đây là bản quét. Dùng “Đọc bằng Antigravity”.',
  indexOff: 'Đang tắt index. Bật lại trong cài đặt chỉ mục.',
  ocrConfirm:
    'Đọc ngay tệp PDF quét này bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  ocrIndexed: 'Các trang đã được đọc từ trước; chữ đã vào chỉ mục.',
  ocrStarted: 'Đây là bản quét: đang đọc bằng Antigravity…',
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
const IOpen = () => (
  <Svg>
    <path d="M9.2 2.6h4.2v4.2M13.4 2.6 7.2 8.8" />
    <path d="M11.6 9.4v2.8a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V5.6a1.2 1.2 0 0 1 1.2-1.2h2.8" />
  </Svg>
)
const ILater = () => (
  <Svg>
    <path d="M8 3v7.2M4.8 7.4 8 10.6l3.2-3.2M3.4 13h9.2" />
  </Svg>
)
const IStop = () => (
  <Svg>
    <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.6" />
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
      // a scanned PDF has no text to read: the only way to read it is Antigravity, so go on to
      // that at once; the person pressed Read because they want this file readable now
      if (result.ok && result.empty && /\.pdf$/i.test(item.path)) {
        say(w.ocrStarted)
        await readWithAntigravity(item)
        await settle(item)
        return
      }
      say(
        result.ok
          ? result.empty
            ? w.readEmpty
            : w.readDone
          : result.error === 'paused'
            ? w.indexOff
            : fill(w.ocrFailed, { e: result.error ?? '' }),
      )
      await settle(item)
    })
  const stop = (item: FileItem) =>
    withBusy(item.id, async () => {
      const result = await api.stopIndexFile(item.id)
      say(result.ok ? w.stopped : fill(w.ocrFailed, { e: result.error ?? '' }))
      await settle(item)
    })
  const later = (item: FileItem) =>
    withBusy(item.id, async () => {
      const result = await api.deferIndexFile(item.id)
      say(result.ok ? w.deferred : fill(w.ocrFailed, { e: result.error ?? '' }))
      await settle(item)
    })
  const openFile = async (item: FileItem) => {
    const result = await api.documentMemoryOpen(item.id).catch(() => null)
    if (!result?.ok) say(w.couldNotOpen)
  }
  const copyPath = async (item: FileItem) => {
    try {
      await navigator.clipboard.writeText(item.path)
      say(w.copied)
    } catch {
      say(item.path)
    }
  }
  // Antigravity reads the pages of a scan; the person has already agreed to it being used
  const readWithAntigravity = async (item: FileItem) => {
    try {
      const result = await api.readScannedPdfWithAgy(item.id, true)
      say(
        result.ok
          ? result.pages
            ? fill(w.ocrDone, { n: result.pages })
            : w.ocrIndexed
          : fill(w.ocrFailed, { e: result.error ?? '' }),
      )
    } catch (error) {
      say(fill(w.ocrFailed, { e: error instanceof Error ? error.message : '' }))
    }
  }
  const readNow = (item: FileItem) =>
    withBusy(item.id, async () => {
      if (!window.confirm(w.ocrConfirm)) return
      await readWithAntigravity(item)
      await settle(item)
    })
  return {
    open,
    toggle,
    details,
    busy,
    note,
    say,
    copyLog,
    copyPath,
    openFile,
    retry,
    stop,
    later,
    readNow,
  }
}

export type FileActions = ReturnType<typeof useFileActions>

interface MenuEntry {
  label: string
  icon: ReactNode
  run: () => void
  disabled?: boolean
}

/** The right-click menu of a file row: the same actions as the icons, plus copy path. */
function FileMenu({
  at,
  entries,
  onClose,
}: {
  at: { x: number; y: number }
  entries: MenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState(at)
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    // keep the menu inside the window
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - box.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - box.height - 4)),
    })
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [at])
  useEffect(() => {
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('contextmenu', away)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('contextmenu', away)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  return (
    <ul ref={ref} className="ixp-menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {entries.map((entry) => (
        <li key={entry.label} role="none">
          <button
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.run()
            }}
          >
            {entry.icon}
            {entry.label}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** One file: icon, name, cause, progress and icon actions; the name opens its log. */
export function FileRow({
  item,
  actions,
  api,
  status,
  live = null,
  finished = false,
  picked = false,
  pickedCount = 0,
  onPick,
  onReadPicked,
  onClearPicked,
}: {
  item: FileItem
  actions: FileActions
  /** this file is part of the pick (Ctrl/Shift+click) */
  picked?: boolean
  pickedCount?: number
  /** a click with Ctrl/Cmd or Shift; a plain click clears the pick */
  onPick?: (item: FileItem, mode: 'toggle' | 'range' | 'clear') => void
  onReadPicked?: () => void
  onClearPicked?: () => void
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
      ? live.pages
        ? fill(w.readingPages, { t: clock(live.since), d: live.pages.done, p: live.pages.total })
        : fill(w.reading, { t: clock(live.since) })
      : live?.kind === 'embedding'
        ? fill(w.embedding, { d: live.done, n: live.total })
        : live?.kind === 'queued'
          ? live.pages
            ? fill(w.queuedPages, { n: live.position, d: live.pages.done, p: live.pages.total })
            : fill(w.queued, { n: live.position })
          : live?.kind === 'paused'
            ? w.pausedNow
            : ''
  const working = live?.kind === 'reading' || live?.kind === 'embedding'
  // the group already says why a scan is listed, so the line under it says where the file is
  const sub = item.reason === 'no-text' ? folderOf(item.path) : item.error
  const stoppable = working || live?.kind === 'queued' || item.reason === 'waiting'
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  const bulk = picked && pickedCount > 1
  const entries: MenuEntry[] = bulk
    ? [
        {
          label: fill(w.readPicked, { n: pickedCount }),
          icon: <IRetry />,
          run: () => onReadPicked?.(),
        },
        { label: w.clearPicked, icon: <IStop />, run: () => onClearPicked?.() },
      ]
    : [
        { label: w.openFile, icon: <IOpen />, run: () => void actions.openFile(item) },
        {
          label: w.reveal,
          icon: <IFolder />,
          run: () => void api.revealDocumentIndexFile(item.id),
        },
        ...(retryable || item.status === 'ready'
          ? [
              {
                label:
                  item.reason === 'waiting'
                    ? w.readFirst
                    : item.status === 'ready'
                      ? w.reread
                      : w.retry,
                icon: <IRetry />,
                disabled: busy,
                run: () => void actions.retry(item),
              },
            ]
          : []),
        ...(stoppable
          ? [
              {
                label: w.later,
                icon: <ILater />,
                disabled: busy,
                run: () => void actions.later(item),
              },
              {
                label: w.stop,
                icon: <IStop />,
                disabled: busy,
                run: () => void actions.stop(item),
              },
            ]
          : []),
        { label: w.copyPath, icon: <ICopy />, run: () => void actions.copyPath(item) },
        { label: w.copyLog, icon: <ICopy />, run: () => void actions.copyLog(item) },
      ]
  const progress =
    live?.kind === 'embedding'
      ? { kind: 'chunks' as const, done: live.done, total: live.total }
      : item.progress
  return (
    <li
      className={`${isOpen ? 'is-selected' : ''}${finished ? ' is-done' : ''}${picked ? ' is-picked' : ''}`}
      aria-selected={onPick ? picked : undefined}
    >
      <div className="ixp-row" onContextMenu={onContextMenu}>
        <button
          type="button"
          className="ixp-main"
          aria-expanded={isOpen}
          onClick={(event) => {
            if (onPick && (event.ctrlKey || event.metaKey || event.shiftKey)) {
              event.preventDefault()
              onPick(item, event.shiftKey ? 'range' : 'toggle')
              return
            }
            onPick?.(item, 'clear')
            actions.toggle(item)
          }}
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
            {(finished || liveText || status || sub) && (
              <span className={`ixp-file-sub${working ? ' is-live' : ''}`} title={sub}>
                {finished ? w.done : liveText || (status ?? sub)}
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
          <IconButton label={w.openFile} onClick={() => void actions.openFile(item)}>
            <IOpen />
          </IconButton>
          {stoppable && (
            <IconButton label={w.later} disabled={busy} onClick={() => void actions.later(item)}>
              <ILater />
            </IconButton>
          )}
          {stoppable && (
            <IconButton label={w.stop} disabled={busy} onClick={() => void actions.stop(item)}>
              <IStop />
            </IconButton>
          )}
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
      {menu && <FileMenu at={menu} entries={entries} onClose={() => setMenu(null)} />}
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
