import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi, LegacyConvertState } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { isRetryableReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { buildIssueSections, narrowSummary, type IssueSectionRow } from './index-issue-groups'
import { runIndexMutation } from './index-mutation'
import { isLegacyConvertState } from './todo-model'
import { IndexProblems } from './IndexProblems'
import { IconChevron } from './index-icons'

/**
 * What needs a person, as a short list: one line per kind of trouble with a count, one button to try
 * again where trying again can help, and the files behind it a click away. Files the index skipped on
 * purpose (blank pages, scans that need OCR, too large) sit in one quiet group underneath.
 */
export const IndexAttention = forwardRef<
  HTMLElement,
  { api: HomeApi; attention: IndexIssueSummary | null; onChanged: () => void; bare?: boolean }
>(function IndexAttention({ api, attention, onChanged, bare }, ref) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const s = d.screen
  const g = d.issues
  const num = (n: number) => n.toLocaleString(dateLocale)
  const [open, setOpen] = useState<string | null>(null)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [note, setNote] = useState('')
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
    if (!legacy?.running) return
    const timer = setInterval(() => void readLegacy(), 3000)
    return () => clearInterval(timer)
  }, [legacy?.running, readLegacy])
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
  const showLegacy = !!legacy && (legacy.running || legacy.pending > 0 || legacy.failed > 0)
  if (needs.length === 0 && skipped.length === 0 && !showLegacy) return null

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
      row.id === 'auto' ? { title: g.autoTitle, hint: g.autoHint } : g.cat[row.id as keyof typeof g.cat]
    const isOpen = open === row.id
    return (
      <li key={row.id} className={`ix-issue${quiet ? ' is-quiet' : ''}${isOpen ? ' is-open' : ''}`}>
        <div className="ix-issue-head">
          <button
            type="button"
            className="ix-issue-main"
            aria-expanded={isOpen}
            title={isOpen ? g.hide : g.show}
            onClick={() => setOpen(isOpen ? null : row.id)}
          >
            <span className="ix-chev" aria-hidden="true">
              <IconChevron />
            </span>
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
        </div>
        {isOpen && attention && (
          <div className="ix-issue-body">
            <IndexProblems
              api={api}
              root="*"
              onChanged={onChanged}
              hideEmpty
              summary={narrowSummary(attention, row.reasons)}
              bucket="all"
              sort="queue"
              grouping="reason"
              descending={false}
            />
          </div>
        )}
      </li>
    )
  }

  return (
    <section className="ix-section" ref={ref} aria-labelledby="ix-attention-h">
      {!bare && (needs.length > 0 || showLegacy) && (
        <div className="ix-section-head">
          <h2 id="ix-attention-h">{s.attention}</h2>
        </div>
      )}
      {note && (
        <p className="ix-note" role="status">
          {note}
        </p>
      )}
      {(needs.length > 0 || showLegacy) && (
        <ul className="ix-issues">
          {showLegacy && legacy && (
            <li className="ix-issue">
              <div className="ix-issue-head">
                <span className="ix-issue-main is-static">
                  <span className="ix-issue-text">
                    <strong>
                      {legacy.running ? s.legacyRunning : fill(s.legacyWaiting, { n: num(legacy.pending) })}
                    </strong>
                    {legacy.failed > 0 && <span>{fill(s.legacyFailed, { n: num(legacy.failed) })}</span>}
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
          {needs.map((row) => rowView(row, false))}
        </ul>
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
          {skippedOpen && <ul className="ix-issues">{skipped.map((row) => rowView(row, true))}</ul>}
        </div>
      )}
    </section>
  )
})
