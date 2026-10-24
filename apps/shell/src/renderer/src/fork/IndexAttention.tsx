import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi, LegacyConvertState } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { isRetryableReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { buildIssueSections, type IssueSectionRow } from './index-issue-groups'
import { runIndexMutation } from './index-mutation'
import { isLegacyConvertState } from './todo-model'
import { IndexIssueFiles } from './IndexIssueFiles'
import { IconChevron } from './index-icons'
import { ocrSourceCopy } from '../i18n/strings-ocr-source'
import { indexV2Words } from '../i18n/strings-index-v2'
import { IndexCardHeading, IndexOverflow } from './IndexCard'
import { IconAlert } from './index-icons'
import { MenuItem } from './IndexMenu'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexBrowserQuery } from '../../../shared/fork/index-browser'
import { IndexFileToolbar, type FileGrouping } from './IndexFileToolbar'
import { IndexFileBrowser } from './IndexFileBrowser'
import { parseIndexView } from './index-screen-model'

/** Kinds of trouble listed before the rest fold behind "Show N more". */
const TOP_GROUPS = 3
/** Disconnected locations spelled out before the rest fold behind "Show N more". */
const OFFLINE_SHOWN = 2
const VIEW_KEY = 'genoffice.index.todo.view'
const savedView = () => {
  try {
    return parseIndexView(localStorage.getItem(VIEW_KEY))
  } catch {
    return parseIndexView(null)
  }
}

/**
 * What needs a person, as a short list: one line per kind of trouble with a count, one button to try
 * again where trying again can help, and the files behind it a click away. Files the index skipped on
 * purpose (blank pages, scans that need OCR, too large) sit in one quiet group underneath.
 */
export const IndexAttention = forwardRef<
  HTMLElement,
  {
    api: HomeApi
    attention: IndexIssueSummary | null
    onChanged: () => void
    now?: IndexingNow | null
  }
>(function IndexAttention({ api, attention, onChanged, now = null }, ref) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const s = d.screen
  const g = d.issues
  const num = (n: number) => n.toLocaleString(dateLocale)
  const w = indexV2Words(lang)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [offlineAll, setOfflineAll] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [filters, setFilters] = useState<IndexBrowserQuery>(() => ({
    sort: savedView().sort,
    descending: savedView().descending,
  }))
  const [filterGroup, setFilterGroup] = useState<FileGrouping>(() => savedView().grouping)
  useEffect(() => {
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({
          sort: filters.sort,
          grouping: filterGroup,
          descending: !!filters.descending,
        }),
      )
    } catch {
      /* preferences remain usable for this visit */
    }
  }, [filters.sort, filters.descending, filterGroup])
  const inFlight = useRef(false)

  // The older-Office converter is read once, then only while it runs.
  const [legacy, setLegacy] = useState<LegacyConvertState | null>(null)
  const [starting, setStarting] = useState(false)
  const alive = useRef(true)
  const readLegacy = useCallback(async () => {
    try {
      const state = await api.getLegacyConvertState?.()
      if (alive.current && isLegacyConvertState(state)) setLegacy(state)
    } catch {
      /* no conversion card */
    }
  }, [api])
  useEffect(() => {
    alive.current = true
    void readLegacy()
    return () => {
      alive.current = false
    }
  }, [readLegacy])
  useEffect(() => {
    if (legacy?.running && now) void readLegacy()
  }, [legacy?.running, readLegacy, now])
  const convert = async () => {
    if (starting) return
    setStarting(true)
    try {
      const state = await api.startLegacyConvert?.()
      if (isLegacyConvertState(state)) setLegacy(state)
      onChanged()
    } catch {
      setNote(d.actionFailed)
    } finally {
      setStarting(false)
    }
  }

  const sections = buildIssueSections(attention?.groups ?? [])
  const needs = sections.needs
  const skipped = [...sections.skipped, ...(sections.auto ? [sections.auto] : [])]
  const skippedTotal = skipped.reduce((n, row) => n + row.count, 0)
  const reasons = [...needs, ...skipped].flatMap((row) => row.reasons)
  const filtering =
    !!filters.query?.trim() ||
    !!filters.status ||
    !!filters.type ||
    !!filters.descending ||
    filters.sort !== 'queue' ||
    filterGroup !== 'reason' ||
    !!filters.reasons
  const showLegacy = !!legacy && (legacy.running || legacy.pending > 0 || legacy.failed > 0)
  const offline = attention?.offlineRoots ?? []
  const sourceCopy = ocrSourceCopy[lang] ?? ocrSourceCopy.en!
  if (needs.length === 0 && skipped.length === 0 && !showLegacy && !offline.length) return null

  const retry = async (row: IssueSectionRow) => {
    if (inFlight.current) return
    inFlight.current = true
    setRetrying(row.id)
    setNote('')
    try {
      let queued = 0
      for (const reason of row.reasons.filter(isRetryableReason)) {
        const result = await runIndexMutation(() => api.retryDocumentIndexGroup('*', reason))
        if (!result.ok) throw new Error(result.error ?? 'retry failed')
        queued += result.retried
      }
      setNote(fill(g.retried, { n: num(queued) }))
      onChanged()
    } catch {
      setNote(g.retryFailed)
    } finally {
      inFlight.current = false
      setRetrying(null)
    }
  }

  const rowView = (row: IssueSectionRow, quiet: boolean) => {
    const text =
      row.id === 'auto'
        ? { title: g.autoTitle, hint: g.autoHint }
        : g.cat[row.id as keyof typeof g.cat]
    const isOpen = open.has(row.id)
    return (
      <li key={row.id} className={`ix-issue${quiet ? ' is-quiet' : ''}${isOpen ? ' is-open' : ''}`}>
        <div className="ix-issue-head">
          <button
            type="button"
            className="ix-issue-main"
            aria-expanded={isOpen}
            title={isOpen ? g.hide : g.show}
            onClick={() =>
              setOpen((current) => {
                const next = new Set(current)
                if (next.has(row.id)) next.delete(row.id)
                else next.add(row.id)
                return next
              })
            }
          >
            <span className="ix-issue-text">
              <strong>{text.title}</strong>
              <span>{text.hint}</span>
            </span>
            <span className="ix-issue-count">{num(row.count)}</span>
          </button>
          {!quiet && row.retryable && (
            <button
              type="button"
              className="ix-btn is-small"
              disabled={retrying !== null}
              onClick={() => void retry(row)}
            >
              {retrying === row.id ? g.retrying : g.retry}
            </button>
          )}
          <span className="ix-chev ix-row-chev" aria-hidden="true">
            <IconChevron />
          </span>
        </div>
        {isOpen && attention && (
          <div className="ix-issue-body">
            <IndexIssueFiles
              api={api}
              reasons={row.reasons}
              count={row.count}
              now={now}
              onChanged={onChanged}
            />
          </div>
        )}
      </li>
    )
  }

  return (
    <section className="ix-section ix-card" ref={ref} aria-label={s.attention}>
      <IndexCardHeading title={s.attention} hint={w.attentionHint} icon={<IconAlert />}>
        {needs.length + skipped.length > 1 && (
          <IndexOverflow label={w.more}>
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close()
                    setShowAll(true)
                    setSkippedOpen(true)
                    setOpen(new Set([...needs, ...skipped].map((row) => row.id)))
                  }}
                >
                  {w.expandAll}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close()
                    setOpen(new Set())
                  }}
                >
                  {w.collapseAll}
                </MenuItem>
              </>
            )}
          </IndexOverflow>
        )}
      </IndexCardHeading>
      {offline.length > 0 && (
        <div className="ix-note ix-offline" role="status">
          <div className="ix-offline-text">
            {(offlineAll ? offline : offline.slice(0, OFFLINE_SHOWN)).map((source) => (
              <p key={source.root}>
                {fill(sourceCopy.waiting, {
                  root: source.root,
                  date: new Date(source.since).toLocaleString(dateLocale),
                  n: num(source.waiting),
                })}
              </p>
            ))}
            {offline.length > OFFLINE_SHOWN && (
              <button type="button" className="ix-link" onClick={() => setOfflineAll((v) => !v)}>
                {offlineAll
                  ? s.groupsFewer
                  : s.groupsMore.replace('{n}', num(offline.length - OFFLINE_SHOWN))}
              </button>
            )}
          </div>
          {api.checkDocumentIndexSources && (
            <button
              type="button"
              className="ix-btn is-small"
              onClick={() => {
                void api.checkDocumentIndexSources!()
                  .then(onChanged)
                  .catch(() => setNote(d.actionFailed))
              }}
            >
              {sourceCopy.check}
            </button>
          )}
        </div>
      )}
      {note && (
        <p className="ix-note" role="status">
          {note}
        </p>
      )}
      {reasons.length > 0 && (
        <IndexFileToolbar
          value={filters}
          onChange={setFilters}
          grouping={filterGroup}
          onGroup={setFilterGroup}
          reasons={reasons}
        />
      )}
      {filtering && reasons.length > 0 ? (
        <IndexFileBrowser
          api={api}
          scope={{ ...filters, reasons: filters.reasons ?? reasons }}
          hideToolbar
          groupMode={filterGroup}
          now={now}
          revision={attention?.total ?? 0}
          onChanged={onChanged}
        />
      ) : (
        <>
          {(needs.length > 0 || showLegacy) && (
            <ul className="ix-issues">
              {showLegacy && legacy && (
                <li className="ix-issue">
                  <div className="ix-issue-head">
                    <span className="ix-issue-main is-static">
                      <span className="ix-issue-text">
                        <strong>
                          {legacy.running
                            ? s.legacyRunning
                            : fill(s.legacyWaiting, { n: num(legacy.pending) })}
                        </strong>
                        {legacy.failed > 0 && (
                          <span>{fill(s.legacyFailed, { n: num(legacy.failed) })}</span>
                        )}
                      </span>
                    </span>
                    {!legacy.running && legacy.pending > 0 && (
                      <button
                        type="button"
                        className="ix-btn is-small"
                        disabled={starting}
                        onClick={() => void convert()}
                      >
                        {starting ? s.converting : s.convert}
                      </button>
                    )}
                  </div>
                </li>
              )}
              {(showAll ? needs : needs.slice(0, TOP_GROUPS)).map((row) =>
                rowView(row, row.id === 'gone'),
              )}
            </ul>
          )}
          {needs.length > TOP_GROUPS && (
            <button
              type="button"
              className="ix-link ix-more-groups"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? s.groupsFewer
                : s.groupsMore.replace('{n}', num(needs.length - TOP_GROUPS))}
            </button>
          )}
          {skipped.length > 0 && (
            <div className="ix-skipped">
              <button
                type="button"
                className="ix-link ix-skipped-toggle"
                aria-expanded={skippedOpen}
                onClick={() => setSkippedOpen((v) => !v)}
              >
                <span className={`ix-chev${skippedOpen ? ' is-open' : ''}`} aria-hidden="true">
                  <IconChevron />
                </span>
                {s.skipped} · {fill(s.skippedFiles, { n: num(skippedTotal) })}
              </button>
              {skippedOpen && (
                <ul className="ix-issues">{skipped.map((row) => rowView(row, true))}</ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
})
