import { useEffect, useRef, useState } from 'react'
import type { DocumentMemoryStatus, HomeIndexingActivity } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexingModeState } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { deriveIndexSummary } from './index-summary'
import { deriveIndexStatus, etaText } from './index-status'
import { IndexProgressTracker, type IndexProgressReading } from './index-progress-model'
import { deriveHeadline, type Headline } from './index-screen-model'

export interface StatusModelInput {
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
  now: IndexingNow | null
  attention: IndexIssueSummary | null
  hasFolders: boolean
}

export interface StatusModel {
  head: Headline
  /** the one sentence */
  title: string
  /** the facts under it: progress, time left, why it is held */
  meta: string[]
  /** the file being read right now */
  current: string
  showBar: boolean
  /** switched off by the person (so a Resume is the way back) */
  isOff: boolean
  /** the index is on and nothing holds it back */
  enabled: boolean
  /** problems the person can act on */
  problems: number
  waiting: number
}

/** What the status sentence says, computed once so every layout reads the same words. */
export function useIndexStatusModel(input: StatusModelInput): StatusModel {
  const { memory, activity, mode, now, attention } = input
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const s = d.screen
  const copy = activityCopy(lang)
  const num = (n: number) => n.toLocaleString(dateLocale)
  const switchedOff = memory?.enabled === false
  const held = !!mode?.effective?.paused
  const progress = activity?.folderProgress ?? null
  const searchable = progress
    ? progress.readyFiles + (progress.releasedFiles ?? 0)
    : (memory?.documents ?? 0)
  const summary = deriveIndexSummary({ activity, memoryPending: memory?.pending, attention })

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
    hasFolders: input.hasFolders,
    searchable,
    total: progress?.totalFiles ?? null,
  })
  const title =
    head.kind === 'paused'
      ? head.why === 'user'
        ? s.head.pausedUser
        : fill(s.head.paused, { why: d.why[head.why ?? 'user'] })
      : s.head[head.kind]
  const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
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
  return {
    head,
    title,
    meta,
    current: now?.extracting?.[0]?.path || now?.activeEmbeddingPath || '',
    showBar: head.kind === 'working' || head.kind === 'downloading' || head.kind === 'scanning',
    isOff: head.kind === 'paused' && head.why === 'user',
    enabled: !switchedOff,
    problems: summary.problems,
    waiting: summary.waiting,
  }
}
