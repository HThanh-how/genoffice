import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssue, IndexIssueReason } from '../../../main/document-memory/issues'
import { isInformationalReason, isRetryableReason } from '../../../main/document-memory/issues'
import type { Lang } from '@genoffice/i18n'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { FileRow, IChevron, IRetry, IconButton, useFileActions } from './IndexFiles'

/** Something the person can act on: failures, and scanned files still waiting to be read. */
export function needsAction(reason: IndexIssueReason): boolean {
  return reason === 'no-text' || !isInformationalReason(reason)
}

const BATCH = 10

const EN = {
  retryEverything: 'Try all errors again',
  readBatch: 'Read {n} scanned files now',
  readBatchConfirm:
    'Read {n} scanned PDFs now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
  readProgress: 'Reading {i} of {n}…',
  readFinished: 'Read {ok} of {n} files.',

  empty: 'No problems. Every readable file is indexed.',
  noFolder: 'Scan a folder first.',
  attention: 'To do',
  skipped: 'Skipped on purpose',
  retryAll: 'Try all again',
  more: 'Show more ({n} left)',
  retried: 'Queued {n} files again.',
  loading: 'Loading…',
}
type Dict = typeof EN
const VI: Dict = {
  retryEverything: 'Thử lại tất cả lỗi',
  readBatch: 'Đọc ngay {n} tệp quét',
  readBatchConfirm:
    'Đọc ngay {n} tệp PDF quét bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  readProgress: 'Đang đọc {i}/{n}…',
  readFinished: 'Đã đọc {ok}/{n} tệp.',

  empty: 'Không có lỗi. Mọi tệp đọc được đều đã index.',
  noFolder: 'Hãy quét một thư mục trước.',
  attention: 'Cần xử lý',
  skipped: 'Bỏ qua có chủ đích',
  retryAll: 'Thử lại cả nhóm',
  more: 'Xem thêm ({n} tệp nữa)',
  retried: 'Đã xếp lại {n} tệp.',
  loading: 'Đang tải…',
}

interface GroupState {
  items: IndexIssue[]
  total: number
  loading: boolean
}

export function IndexProblems({
  api,
  root,
  focus,
  onChanged,
}: {
  api: HomeApi
  root: string
  /** a group to open at once (picked from the overview) */
  focus?: IndexIssueReason | null
  onChanged: () => void
}) {
  const { lang, dateLocale } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const copy = activityCopy(lang as Lang)
  const [summary, setSummary] = useState<IndexIssueSummary | null>(null)
  const [open, setOpen] = useState<Set<IndexIssueReason>>(new Set())
  const [groups, setGroups] = useState<Partial<Record<IndexIssueReason, GroupState>>>({})

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

  const groupsRef = useRef(groups)
  groupsRef.current = groups
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
        const offset = append ? (groupsRef.current[reason]?.items.length ?? 0) : 0
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
    [api, root],
  )

  const actions = useFileActions(
    api,
    (reason) => copy.reasons[reason].title,
    onChanged,
    async (item) => {
      await loadSummary()
      if (item.reason) await loadGroup(item.reason)
    },
  )

  // The only attention group opens by itself, and a group picked on the overview opens too.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!summary) return
    const wanted =
      focus && summary.groups.some((g) => g.reason === focus)
        ? focus
        : !autoOpened.current && summary.groups.filter((g) => needsAction(g.reason)).length === 1
          ? summary.groups.find((g) => needsAction(g.reason))!.reason
          : null
    autoOpened.current = true
    if (wanted) {
      setOpen((current) => new Set(current).add(wanted))
      if (!groupsRef.current[wanted]) void loadGroup(wanted)
    }
  }, [summary, focus, loadGroup])

  const toggle = (reason: IndexIssueReason) => {
    const next = new Set(open)
    if (next.has(reason)) next.delete(reason)
    else {
      next.add(reason)
      if (!groups[reason]) void loadGroup(reason)
    }
    setOpen(next)
  }

  const retryEverything = async () => {
    let queued = 0
    for (const group of summary?.groups ?? []) {
      if (
        !needsAction(group.reason) ||
        !isRetryableReason(group.reason) ||
        group.reason === 'waiting'
      )
        continue
      const result = await api.retryDocumentIndexGroup(root, group.reason)
      if (result.ok) queued += result.retried
    }
    actions.say(fill(d.retried, { n: queued }))
    await loadSummary()
    for (const reason of open) await loadGroup(reason)
    onChanged()
  }

  const readBatch = async () => {
    const page = await api.getDocumentIndexIssues(root, 0, 'no-text')
    const batch = page.items.slice(0, BATCH)
    if (batch.length === 0) return
    if (!window.confirm(fill(d.readBatchConfirm, { n: batch.length }))) return
    let ok = 0
    for (const [index, item] of batch.entries()) {
      actions.say(fill(d.readProgress, { i: index + 1, n: batch.length }))
      try {
        const result = await api.readScannedPdfWithAgy(item.id, true)
        if (!result.ok) break
        ok++
      } catch {
        break
      }
    }
    actions.say(fill(d.readFinished, { ok, n: batch.length }))
    await loadSummary()
    if (open.has('no-text')) await loadGroup('no-text')
    onChanged()
  }

  const retryGroup = async (reason: IndexIssueReason) => {
    const result = await api.retryDocumentIndexGroup(root, reason)
    actions.say(result.ok ? fill(d.retried, { n: result.retried }) : (result.error ?? ''))
    await Promise.all([loadSummary(), loadGroup(reason)])
    onChanged()
  }

  if (!root) return <p className="idx-muted">{d.noFolder}</p>
  const list = summary?.groups ?? []
  if (summary && list.length === 0) return <p className="idx-empty">{d.empty}</p>

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
              <FileRow key={issue.id} item={issue} actions={actions} api={api} />
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

  const attention = list.filter((g) => needsAction(g.reason))
  const skipped = list.filter((g) => !needsAction(g.reason))
  const scanned = list.find((g) => g.reason === 'no-text')?.count ?? 0
  const failures = attention.some((g) => isRetryableReason(g.reason))
  return (
    <div className="ixp">
      {actions.note && (
        <p className="ixp-note" role="status">
          {actions.note}
        </p>
      )}
      {(failures || scanned > 0) && (
        <div className="ixp-toolbar">
          {failures && (
            <button
              type="button"
              className="idx-btn primary"
              onClick={() => void retryEverything()}
            >
              {d.retryEverything}
            </button>
          )}
          {scanned > 0 && (
            <button type="button" className="idx-btn" onClick={() => void readBatch()}>
              {fill(d.readBatch, { n: Math.min(BATCH, scanned) })}
            </button>
          )}
        </div>
      )}
      {attention.length > 0 && (
        <>
          <h2 className="ixp-title">{d.attention}</h2>
          {attention.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
      {skipped.length > 0 && (
        <>
          <h2 className="ixp-title">{d.skipped}</h2>
          {skipped.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
    </div>
  )
}
