import { useEffect, useRef, useState } from 'react'
import type { DocumentMemoryStatus, HomeApi, HomeIndexingActivity } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexingModeState } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { deriveIndexSummary } from './index-summary'
import { deriveIndexStatus, etaText } from './index-status'
import { IndexProgressTracker, type IndexProgressReading } from './index-progress-model'
import { deriveHeadline } from './index-screen-model'
import { narrowSummary } from './index-issue-groups'
import { IndexProblems } from './IndexProblems'
import { IconAlert, IconCheck, IconPause } from './index-icons'

export interface IndexStatusProps {
  api: HomeApi
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
  now: IndexingNow | null
  attention: IndexIssueSummary | null
  hasFolders: boolean
  /** no reading has answered yet */
  loading: boolean
  /** the reading failed (a last good one may still be shown) */
  failed: boolean
  busy: boolean
  onToggle: () => void
  onRetryModel: () => void
  onRefresh: () => void
  onChanged: () => void
}

/**
 * The top of the screen: one sentence saying what is happening, one bar, the time left, and the one
 * control that matters (pause or resume). Every number on the screen about "how far along" comes
 * from here once; the folder rows below only describe their own folder.
 */
export function IndexStatus(props: IndexStatusProps) {
  const { api, memory, activity, mode, now, attention } = props
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const s = d.screen
  const copy = activityCopy(lang)
  const num = (n: number) => n.toLocaleString(dateLocale)
  const [queueOpen, setQueueOpen] = useState(false)

  const switchedOff = memory?.enabled === false
  const held = !!mode?.effective?.paused
  const progress = activity?.folderProgress ?? null
  const searchable = progress
    ? progress.readyFiles + (progress.releasedFiles ?? 0)
    : (memory?.documents ?? 0)
  const summary = deriveIndexSummary({ activity, memoryPending: memory?.pending, attention })

  // Time left comes from the rolling tracker; it stays silent until the evidence is solid.
  const tracker = useRef(new IndexProgressTracker())
  const [reading, setReading] = useState<IndexProgressReading | null>(null)
  useEffect(() => {
    setReading(tracker.current.record(Date.now(), activity, held || switchedOff))
  }, [activity, held, switchedOff])

  const modelState = activity?.memory.modelState ?? memory?.modelState ?? 'not-loaded'
  const status = deriveIndexStatus({
    summary,
    switchedOff,
    held,
    ...(mode?.effective?.pauseReason ? { pauseReason: mode.effective.pauseReason } : {}),
    modelBlocked: modelState === 'blocked',
    reading: !!(now?.extracting && now.extracting.length > 0),
    ready: searchable,
    eta: reading?.eta ?? null,
  })
  const folder = activity?.folder ?? null
  const head = deriveHeadline({
    status,
    scanning: !!folder?.running,
    modelState,
    ...(activity?.memory.modelProgress !== undefined
      ? { modelProgress: activity.memory.modelProgress }
      : {}),
    pending: summary.waiting,
    hasFolders: props.hasFolders,
    searchable,
    total: progress?.totalFiles ?? null,
  })

  if (props.loading && !activity && !memory) {
    return props.failed ? (
      <section className="ix-status is-failed" role="alert">
        <p className="ix-status-title">{s.failed}</p>
        <button type="button" className="ix-btn" onClick={props.onRefresh}>
          {s.retry}
        </button>
      </section>
    ) : (
      <section className="ix-status is-loading" aria-busy="true" aria-label={s.loading}>
        <span className="ix-skel ix-skel-title" />
        <span className="ix-skel ix-skel-meta" />
        <span className="ix-skel ix-skel-bar" />
      </section>
    )
  }

  const title =
    head.kind === 'paused'
      ? head.why === 'user'
        ? s.head.pausedUser
        : fill(s.head.paused, { why: d.why[head.why ?? 'user'] })
      : s.head[head.kind]
  const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const current = now?.extracting?.[0]?.path || now?.activeEmbeddingPath || ''
  const meta: string[] = []
  if (head.kind === 'working' || head.kind === 'paused') {
    if (head.total && head.total > 0 && (head.kind === 'working' || head.done < head.total))
      meta.push(fill(s.meta.progress, { done: num(head.done), total: num(head.total) }))
    else if (head.done > 0) meta.push(fill(s.meta.searchable, { n: num(head.done) }))
    if (head.kind === 'working' && head.eta) meta.push(etaText(head.eta, copy, num))
    if (head.kind === 'paused') meta.push(d.status.resumeWhen[head.why ?? 'user'])
  } else if (head.kind === 'downloading') {
    meta.push(fill(s.meta.modelPercent, { p: head.percent ?? 0 }))
  } else if (head.kind === 'scanning' && folder?.root) {
    meta.push(fill(s.meta.scanningIn, { name: name(folder.root) }))
  } else if (head.kind === 'ready') {
    meta.push(fill(s.meta.searchable, { n: num(head.done) }))
  } else if (head.kind === 'modelError' && activity?.memory.lastError) {
    meta.push(activity.memory.lastError)
  }
  const showBar =
    head.kind === 'working' || head.kind === 'downloading' || head.kind === 'scanning'
  const isOff = head.kind === 'paused' && head.why === 'user'
  const action =
    head.kind === 'modelError' ? (
      <button type="button" className="ix-btn" disabled={props.busy} onClick={props.onRetryModel}>
        {s.retry}
      </button>
    ) : isOff ? (
      <button
        type="button"
        className="ix-btn is-primary"
        disabled={props.busy}
        onClick={props.onToggle}
      >
        {s.resume}
      </button>
    ) : head.kind === 'working' || head.kind === 'scanning' || head.kind === 'downloading' ? (
      <button type="button" className="ix-btn" disabled={props.busy} onClick={props.onToggle}>
        <IconPause />
        {s.pause}
      </button>
    ) : null

  const headMark =
    head.kind === 'modelError' ? (
      <IconAlert />
    ) : head.kind === 'paused' ? (
      <IconPause />
    ) : head.kind === 'ready' ? (
      <IconCheck />
    ) : null

  const waiting = attention ? narrowSummary(attention, ['waiting']) : null
  const queueCount = waiting?.total ?? 0

  return (
    <section className={`ix-status is-${head.kind}`} role="status" aria-label={s.title}>
      <div className="ix-status-row">
        <div className="ix-status-text">
          <h2 className="ix-status-title">
            {headMark && (
              <span className="ix-status-mark" aria-hidden="true">
                {headMark}
              </span>
            )}
            {title}
          </h2>
          {meta.length > 0 && (
            <p className="ix-status-meta">
              {meta.map((part, i) => (
                <span key={i}>{part}</span>
              ))}
            </p>
          )}
        </div>
        {action}
      </div>
      {showBar && (
        <div
          className={`ix-bar${head.percent === null ? ' is-indeterminate' : ''}`}
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(head.percent !== null ? { 'aria-valuenow': head.percent } : {})}
        >
          <span style={head.percent !== null ? { width: `${Math.max(2, head.percent)}%` } : {}} />
        </div>
      )}
      {head.kind === 'working' && current && (
        <p className="ix-status-now" title={current}>
          {fill(s.meta.reading, { name: name(current) })}
        </p>
      )}
      {head.kind === 'paused' && head.why === 'saver' && (
        <p className="ix-status-now">{d.status.saverNote}</p>
      )}
      {queueCount > 0 && head.kind !== 'ready' && (
        <>
          <button
            type="button"
            className="ix-link"
            aria-expanded={queueOpen}
            onClick={() => setQueueOpen((v) => !v)}
          >
            {queueOpen ? s.hideQueue : s.showQueue}
          </button>
          {queueOpen && waiting && (
            <div className="ix-status-queue">
              <IndexProblems
                api={api}
                root="*"
                onChanged={props.onChanged}
                hideEmpty
                summary={waiting}
                bucket="all"
                sort="queue"
                grouping="reason"
                descending={false}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}
