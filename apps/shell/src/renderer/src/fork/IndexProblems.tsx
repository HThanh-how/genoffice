import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexFileDetail } from '../../../shared/fork/document-index-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssue, IndexIssueReason } from '../../../main/document-memory/issues'
import { isInformationalReason, isRetryableReason } from '../../../main/document-memory/issues'
import type { Lang } from '@genoffice/i18n'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { iconFor } from '../file-icons'
import {
  buildFileLog,
  deriveFileSteps,
  formatBytes,
  logWords,
  type StepState,
} from './index-file-log'

const EN = {
  empty: 'No problems. Every readable file is indexed.',
  noFolder: 'Scan a folder first.',
  attention: 'Needs attention',
  skipped: 'Skipped on purpose',
  retryAll: 'Try all again',
  retry: 'Try again',
  readNow: 'Read with Antigravity now',
  copyLog: 'Copy log',
  copied: 'Log copied.',
  reveal: 'Show in folder',
  more: 'Show more ({n} left)',
  retried: 'Queued {n} files again.',
  retriedOne: 'Queued for another try.',
  loading: 'Loading…',
  ocrConfirm:
    'Read this scanned PDF now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
  ocrDone: 'Read {n} pages. It is searchable shortly.',
  ocrFailed: 'Could not read: {e}',
  cause: 'Cause',
  path: 'Path',
  gone: 'The file is gone',
}
type Dict = typeof EN
const VI: Dict = {
  empty: 'Không có lỗi. Mọi tệp đọc được đều đã index.',
  noFolder: 'Hãy quét một thư mục trước.',
  attention: 'Cần xử lý',
  skipped: 'Bỏ qua có chủ đích',
  retryAll: 'Thử lại cả nhóm',
  retry: 'Thử lại',
  readNow: 'Đọc bằng Antigravity ngay',
  copyLog: 'Sao chép nhật ký',
  copied: 'Đã sao chép nhật ký.',
  reveal: 'Mở thư mục chứa tệp',
  more: 'Xem thêm ({n} tệp nữa)',
  retried: 'Đã xếp lại {n} tệp.',
  retriedOne: 'Đã xếp lại để thử lần nữa.',
  loading: 'Đang tải…',
  ocrConfirm:
    'Đọc ngay tệp PDF quét này bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  ocrDone: 'Đã đọc {n} trang. Lát nữa là tìm được.',
  ocrFailed: 'Không đọc được: {e}',
  cause: 'Nguyên nhân',
  path: 'Đường dẫn',
  gone: 'Tệp không còn',
}

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
const IRetry = () => (
  <Svg>
    <path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3" />
    <path d="M13.4 2.2v3h-3" />
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
const IChevron = () => (
  <Svg>
    <path d="M6 3.6 10.4 8 6 12.4" />
  </Svg>
)

function Progress({ issue }: { issue: IndexIssue }) {
  const progress = issue.progress
  if (!progress || progress.total <= 0) return null
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

function IconButton({
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
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

interface GroupState {
  items: IndexIssue[]
  total: number
  loading: boolean
}

export function IndexProblems({
  api,
  root,
  onChanged,
}: {
  api: HomeApi
  root: string
  onChanged: () => void
}) {
  const { lang, dateLocale } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const copy = activityCopy(lang as Lang)
  const lw = logWords(lang)
  const [summary, setSummary] = useState<IndexIssueSummary | null>(null)
  const [open, setOpen] = useState<Set<IndexIssueReason>>(new Set())
  const [groups, setGroups] = useState<Partial<Record<IndexIssueReason, GroupState>>>({})
  const [file, setFile] = useState<number | null>(null)
  const [details, setDetails] = useState<Record<number, IndexFileDetail | null>>({})
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const say = (text: string) => {
    setNote(text)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(''), 4000)
  }
  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), [])

  const loadSummary = useCallback(async () => {
    if (!root) return
    try {
      setSummary(await api.getDocumentIndexIssueSummary(root))
    } catch {
      /* keep what is shown */
    }
  }, [api, root])
  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  const loadGroup = useCallback(
    async (reason: IndexIssueReason, append = false) => {
      setGroups((current) => ({
        ...current,
        [reason]: {
          items: current[reason]?.items ?? [],
          total: current[reason]?.total ?? 0,
          loading: true,
        },
      }))
      try {
        const offset = append ? (groups[reason]?.items.length ?? 0) : 0
        const page = await api.getDocumentIndexIssues(root, offset, reason)
        setGroups((current) => ({
          ...current,
          [reason]: {
            items: append ? [...(current[reason]?.items ?? []), ...page.items] : page.items,
            total: page.total,
            loading: false,
          },
        }))
      } catch {
        setGroups((current) => ({
          ...current,
          [reason]: {
            items: current[reason]?.items ?? [],
            total: current[reason]?.total ?? 0,
            loading: false,
          },
        }))
      }
    },
    [api, root, groups],
  )

  // The only attention group opens by itself: nothing to hunt for.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || !summary) return
    const attention = summary.groups.filter((g) => !isInformationalReason(g.reason))
    autoOpened.current = true
    if (attention.length === 1) {
      setOpen(new Set([attention[0]!.reason]))
      void loadGroup(attention[0]!.reason)
    }
  }, [summary, loadGroup])

  const toggle = (reason: IndexIssueReason) => {
    const next = new Set(open)
    if (next.has(reason)) next.delete(reason)
    else {
      next.add(reason)
      if (!groups[reason]) void loadGroup(reason)
    }
    setOpen(next)
  }

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

  const select = (issue: IndexIssue) => {
    const next = file === issue.id ? null : issue.id
    setFile(next)
    if (next !== null) void detailOf(next)
  }

  const copyLog = async (issue: IndexIssue) => {
    const detail = await detailOf(issue.id)
    const text = detail
      ? buildFileLog(detail, lang, dateLocale, copy.reasons[issue.reason].title)
      : `${issue.path}\n${issue.error ?? ''}`
    try {
      await navigator.clipboard.writeText(text)
      say(d.copied)
    } catch {
      say(text)
    }
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

  const refresh = async (reason: IndexIssueReason) => {
    setDetails({})
    await Promise.all([loadSummary(), loadGroup(reason)])
    onChanged()
  }

  const retryOne = (issue: IndexIssue) =>
    withBusy(issue.id, async () => {
      const result = await api.retryDocumentIndex(issue.id)
      say(result.ok ? d.retriedOne : fill(d.ocrFailed, { e: result.error ?? '' }))
      await refresh(issue.reason)
    })

  const readNow = (issue: IndexIssue) =>
    withBusy(issue.id, async () => {
      if (!window.confirm(d.ocrConfirm)) return
      try {
        const result = await api.readScannedPdfWithAgy(issue.id, true)
        say(
          result.ok
            ? fill(d.ocrDone, { n: result.pages ?? 0 })
            : fill(d.ocrFailed, { e: result.error ?? '' }),
        )
      } catch (error) {
        say(fill(d.ocrFailed, { e: error instanceof Error ? error.message : '' }))
      }
      await refresh(issue.reason)
    })

  const retryGroup = async (reason: IndexIssueReason) => {
    const result = await api.retryDocumentIndexGroup(root, reason)
    say(result.ok ? fill(d.retried, { n: result.retried }) : (result.error ?? ''))
    await refresh(reason)
  }

  if (!root) return <p className="idx-muted">{d.noFolder}</p>
  const list = summary?.groups ?? []
  if (summary && list.length === 0) return <p className="idx-empty">{d.empty}</p>

  const renderDetail = (issue: IndexIssue) => {
    const detail = details[issue.id]
    if (detail === undefined) return <p className="ixp-loading">{d.loading}</p>
    if (detail === null)
      return (
        <div className="ixp-detail">
          <code className="ixp-raw">{issue.error ?? issue.path}</code>
        </div>
      )
    const steps = deriveFileSteps(detail, lang)
    return (
      <div className="ixp-detail">
        <ol className="ixp-steps">
          {steps.map((step) => (
            <li key={step.key} className={`is-${step.state as StepState}`}>
              <i aria-hidden="true" />
              <span className="ixp-step-name">{lw[step.key]}</span>
              <span className="ixp-step-text">{step.text}</span>
            </li>
          ))}
        </ol>
        <dl className="ixp-facts">
          <div>
            <dt>{d.path}</dt>
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
    )
  }

  const renderGroup = (reason: IndexIssueReason, count: number) => {
    const words = copy.reasons[reason]
    const isOpen = open.has(reason)
    const state = groups[reason]
    return (
      <section className={`ixp-group${isOpen ? ' is-open' : ''}`} key={reason}>
        <div className="ixp-head-row">
          <button
            type="button"
            className="ixp-head"
            aria-expanded={isOpen}
            onClick={() => toggle(reason)}
          >
            <span className="ixp-chevron">
              <IChevron />
            </span>
            <span className="ixp-head-text">
              <strong>{words.title}</strong>
              <span>{words.hint}</span>
            </span>
            <span className="ixp-count">{count.toLocaleString(dateLocale)}</span>
          </button>
          {isRetryableReason(reason) && (
            <IconButton label={d.retryAll} onClick={() => void retryGroup(reason)}>
              <IRetry />
            </IconButton>
          )}
        </div>
        {isOpen && (
          <ul className="ixp-files">
            {state?.items.map((issue) => (
              <li key={issue.id} className={file === issue.id ? 'is-selected' : ''}>
                <div
                  className="ixp-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={file === issue.id}
                  onClick={() => select(issue)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      select(issue)
                    }
                  }}
                >
                  <img className="ixp-file-icon" src={iconFor(issue.name)} alt="" />
                  <span className="ixp-file-text">
                    <span className="ixp-file-name" title={issue.path}>
                      {issue.name}
                    </span>
                    {issue.error && <span className="ixp-file-sub">{issue.error}</span>}
                  </span>
                  {busy.has(issue.id) ? (
                    <span className="ixp-spin" aria-hidden="true" />
                  ) : (
                    <Progress issue={issue} />
                  )}
                  <span className="ixp-actions">
                    {reason === 'no-text' && (
                      <IconButton
                        label={d.readNow}
                        disabled={busy.has(issue.id)}
                        onClick={() => void readNow(issue)}
                      >
                        <ISpark />
                      </IconButton>
                    )}
                    {isRetryableReason(reason) && (
                      <IconButton
                        label={d.retry}
                        disabled={busy.has(issue.id)}
                        onClick={() => void retryOne(issue)}
                      >
                        <IRetry />
                      </IconButton>
                    )}
                    <IconButton label={d.copyLog} onClick={() => void copyLog(issue)}>
                      <ICopy />
                    </IconButton>
                    <IconButton
                      label={d.reveal}
                      onClick={() => void api.revealDocumentIndexFile(issue.id)}
                    >
                      <IFolder />
                    </IconButton>
                  </span>
                </div>
                {file === issue.id && renderDetail(issue)}
              </li>
            ))}
            {state?.loading && <li className="ixp-loading">{d.loading}</li>}
            {state && !state.loading && state.total > state.items.length && (
              <li>
                <button
                  type="button"
                  className="idx-link"
                  onClick={() => void loadGroup(reason, true)}
                >
                  {fill(d.more, { n: state.total - state.items.length })}
                </button>
              </li>
            )}
          </ul>
        )}
      </section>
    )
  }

  const attention = list.filter((g) => !isInformationalReason(g.reason))
  const skipped = list.filter((g) => isInformationalReason(g.reason))
  return (
    <div className="ixp">
      {note && (
        <p className="ixp-note" role="status">
          {note}
        </p>
      )}
      {attention.length > 0 && (
        <>
          <h3 className="ixp-title">{d.attention}</h3>
          {attention.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
      {skipped.length > 0 && (
        <>
          <h3 className="ixp-title">{d.skipped}</h3>
          {skipped.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
    </div>
  )
}
