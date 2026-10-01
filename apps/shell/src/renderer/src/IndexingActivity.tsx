import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IndexProgressRing } from '@genoffice/ui'
import '@genoffice/ui/index-progress.css'
import type { HomeApi, HomeIndexingActivity } from '../../shared/home-api'
import type { IndexIssueReason } from '../../main/document-memory/issues'
import { isInformationalReason } from '../../main/document-memory/issues'
import type { IndexIssueSummary } from '../../main/document-memory/issue-reader'
import type { Lang } from '@genoffice/i18n'
import { strings, en } from './indexing-activity-i18n'
import { activityCopy, fill } from './indexing-activity-copy'
import {
  EtaTracker,
  activityEqual,
  createAdaptivePoller,
  deriveIndexView,
  jobKey,
  pollDelay,
  shouldAutoExpand,
  type AdaptivePoller,
  type EtaEstimate,
} from './indexing-activity-model'
import { ModelErrorBox } from './indexing-activity/ModelErrorBox'
import { PanelHeader } from './indexing-activity/PanelHeader'
import { ProblemSections } from './indexing-activity/ProblemSections'
import { StatusBlock } from './indexing-activity/StatusBlock'
import { formatCount, headline, issueWordsFor, type ActionResult } from './indexing-activity/format'
import { IndexingStateNote } from './fork/IndexingStateNote'
import './indexing-activity.css'

export function IndexingActivity({ api, lang }: { api: HomeApi; lang: Lang }) {
  const [activity, setActivity] = useState<HomeIndexingActivity | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [eta, setEta] = useState<EtaEstimate | null>(null)
  const [summary, setSummary] = useState<IndexIssueSummary | null>(null)
  const [note, setNote] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const pollerRef = useRef<AdaptivePoller | null>(null)
  const expandedRef = useRef(false)
  const activeRef = useRef(false)
  const lastJob = useRef('')
  const etaTracker = useRef(new EtaTracker())
  const summaryRequest = useRef(0)
  const words = strings[lang] ?? en
  const copy = activityCopy(lang)

  // --- adaptive polling -------------------------------------------------------------
  // Fast (1 s) only while the panel is open and the window visible; 5 s collapsed while
  // work is running, 10 s when idle; none while the window is hidden. The next request is
  // scheduled only after the previous one settles, so requests never overlap.
  useEffect(() => {
    if (!api.getIndexingActivity) return
    let mounted = true
    const poller = createAdaptivePoller({
      fetch: async () => {
        const next = await api.getIndexingActivity()
        if (!mounted) return
        setActivity((previous) => (activityEqual(previous, next) ? previous : next))
        const view = deriveIndexView(next)
        const job = jobKey(next)
        activeRef.current = !!view?.active
        if (shouldAutoExpand(lastJob.current, job, view)) {
          setDismissed(false)
          setExpanded(true)
        } else if (job !== lastJob.current) {
          setDismissed(false)
        }
        lastJob.current = job
        if (view?.kind === 'indexing')
          etaTracker.current.record(Date.now(), view.finished, view.total)
        else etaTracker.current.reset()
        const estimate = view?.kind === 'indexing' ? etaTracker.current.estimate() : null
        setEta((previous) =>
          previous?.unit === estimate?.unit && previous?.value === estimate?.value
            ? previous
            : estimate,
        )
      },
      getDelay: () =>
        pollDelay({
          expanded: expandedRef.current,
          visible: document.visibilityState === 'visible',
          active: activeRef.current,
        }),
    })
    pollerRef.current = poller
    const onVisibility = () =>
      document.visibilityState === 'visible' ? poller.kick() : poller.reschedule()
    document.addEventListener('visibilitychange', onVisibility)
    poller.kick()
    return () => {
      mounted = false
      poller.stop()
      pollerRef.current = null
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [api])

  useEffect(() => {
    expandedRef.current = expanded
    // Opening shows fresh numbers at once; closing just relaxes the cadence.
    if (expanded) pollerRef.current?.kick()
    else pollerRef.current?.reschedule()
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const collapse = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target))
        setExpanded(false)
    }
    document.addEventListener('pointerdown', collapse, true)
    return () => document.removeEventListener('pointerdown', collapse, true)
  }, [expanded])

  const view = useMemo(() => deriveIndexView(activity), [activity])
  const folder = activity?.folder
  const root = folder?.root ?? ''

  // --- issue summary ----------------------------------------------------------------
  // Grouped counts are fetched when the number of problem files changes (cheap GROUP BY),
  // never from the progress poll.
  const issueCount = (view?.fileErrors ?? 0) + (view?.emptyFiles ?? 0)
  const refreshSummary = useCallback(async () => {
    if (!root || !api.getDocumentIndexIssueSummary) return
    const request = ++summaryRequest.current
    try {
      const next = await api.getDocumentIndexIssueSummary(root)
      if (request === summaryRequest.current) setSummary(next)
    } catch {
      // Keep the previous summary; the counts in the status line still render.
    }
  }, [api, root])
  useEffect(() => {
    summaryRequest.current++
    setSummary(null)
    setNote('')
  }, [root])
  useEffect(() => {
    if (issueCount > 0) void refreshSummary()
    else {
      summaryRequest.current++
      setSummary(null)
    }
  }, [issueCount, refreshSummary])

  const onGroupChanged = useCallback(() => {
    pollerRef.current?.kick()
    void refreshSummary()
  }, [refreshSummary])

  const retryGroup = useCallback(
    async (reason: IndexIssueReason): Promise<ActionResult> => {
      if (!root) return { ok: false }
      const result = await api.retryDocumentIndexGroup(root, reason)
      if (result.ok) setNote(fill(copy.retriedNote, { n: result.retried }))
      onGroupChanged()
      return result
    },
    [api, root, copy, onGroupChanged],
  )

  const retryModel = async () => {
    if (!root || modelBusy) return
    setModelBusy(true)
    try {
      await api.retryDocumentIndexGroup(root, 'model')
    } catch {
      // The status line keeps showing the failure if it persists.
    } finally {
      setModelBusy(false)
      pollerRef.current?.kick()
    }
  }

  if (!view || !folder?.root || dismissed) return null

  const folderName = folder.root.split(/[\\/]/).filter(Boolean).at(-1) || folder.root
  const label = headline(view, words, copy)
  const groups = summary?.groups ?? []
  const attentionGroups = groups.filter((group) => !isInformationalReason(group.reason))
  const skippedGroups = groups.filter((group) => isInformationalReason(group.reason))
  const attentionCount =
    attentionGroups.reduce((sum, group) => sum + group.count, 0) + view.scanErrors
  const skippedCount = skippedGroups.reduce((sum, group) => sum + group.count, 0)
  const ringState =
    view.kind === 'model-error' ? 'error' : view.kind === 'paused' ? 'paused' : 'running'
  const complete = view.kind === 'done'
  const chipPercent = view.kind === 'indexing' && view.percent !== null ? ` · ${view.percent}%` : ''

  const ring = (
    <IndexProgressRing
      percent={view.percent}
      complete={complete}
      state={ringState}
      active={view.active}
      label={label}
    />
  )

  return (
    <div
      className={`indexing-activity is-${view.kind}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          setExpanded(false)
          launcherRef.current?.focus()
        }
      }}
    >
      {expanded && (
        <section className="indexing-activity-panel" aria-label={words.title}>
          <PanelHeader
            words={words}
            root={folder.root}
            folderName={folderName}
            onClose={() => setExpanded(false)}
          />
          <StatusBlock view={view} ring={ring} label={label} eta={eta} lang={lang} copy={copy} />
          <IndexingStateNote api={api} lang={lang} />
          <ModelErrorBox
            view={view}
            copy={copy}
            busy={modelBusy}
            onRetry={() => void retryModel()}
          />
          {note && <p className="indexing-activity-note">{note}</p>}
          <ProblemSections
            api={api}
            folder={folder}
            attentionGroups={attentionGroups}
            skippedGroups={skippedGroups}
            scanErrors={view.scanErrors}
            lang={lang}
            copy={copy}
            words={words}
            onChanged={onGroupChanged}
            onRetryAll={retryGroup}
          />
          <footer>
            <span>
              {words.local}
              {activity?.memory.cpuMode === 'gentle' && ` · ${issueWordsFor(lang).gentle}`}
            </span>
            {folder.running ? (
              <button
                type="button"
                onClick={() => void api.stopDocumentFolderScan().catch(() => undefined)}
              >
                {words.stop}
              </button>
            ) : (
              <button type="button" onClick={() => setDismissed(true)}>
                {copy.hideNotice}
              </button>
            )}
          </footer>
        </section>
      )}
      <button
        type="button"
        ref={launcherRef}
        className="indexing-activity-launcher"
        aria-label={`${words.open}: ${label}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {ring}
        <span className="indexing-activity-launcher-copy">
          <strong>
            {label}
            {chipPercent}
          </strong>
          <small>
            {folderName}
            {skippedCount > 0 && view.kind === 'done'
              ? ` · ${fill(copy.skippedNote, { n: formatCount(skippedCount, lang) })}`
              : ''}
          </small>
        </span>
        {attentionCount > 0 && view.kind !== 'model-error' && (
          <span className="indexing-activity-badge" title={copy.needsAttention}>
            {formatCount(attentionCount, lang)}
          </span>
        )}
      </button>
    </div>
  )
}
