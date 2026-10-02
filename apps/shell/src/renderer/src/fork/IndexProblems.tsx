import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssue, IndexIssueReason } from '../../../main/document-memory/issues'
import { isInformationalReason, isRetryableReason } from '../../../main/document-memory/issues'
import type { Lang } from '@genoffice/i18n'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { FileRow, IChevron, IRetry, IconButton, useFileActions } from './IndexFiles'

const EN = {
  empty: 'No problems. Every readable file is indexed.',
  noFolder: 'Scan a folder first.',
  attention: 'Needs attention',
  skipped: 'Skipped on purpose',
  retryAll: 'Try all again',
  more: 'Show more ({n} left)',
  retried: 'Queued {n} files again.',
  loading: 'Loading…',
}
type Dict = typeof EN
const VI: Dict = {
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
        : !autoOpened.current &&
            summary.groups.filter((g) => !isInformationalReason(g.reason)).length === 1
          ? summary.groups.find((g) => !isInformationalReason(g.reason))!.reason
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

  const attention = list.filter((g) => !isInformationalReason(g.reason))
  const skipped = list.filter((g) => isInformationalReason(g.reason))
  return (
    <div className="ixp">
      {actions.note && (
        <p className="ixp-note" role="status">
          {actions.note}
        </p>
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
