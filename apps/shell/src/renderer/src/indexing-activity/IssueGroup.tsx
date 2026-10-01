import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssue, IndexIssueReason } from '../../../main/document-memory/issues'
import { isRetryableReason } from '../../../main/document-memory/issues'
import type { ActivityCopy } from '../indexing-activity-copy'
import { formatCount, issueWordsFor, type ActionResult, type Words } from './format'

interface GroupFiles {
  items: IndexIssue[]
  total: number
  loading: boolean
  error: string
}

export const IssueGroup = memo(function IssueGroup({
  api,
  root,
  reason,
  count,
  lang,
  copy,
  words,
  onChanged,
  onRetryAll,
}: {
  api: HomeApi
  root: string
  reason: IndexIssueReason
  count: number
  lang: Lang
  copy: ActivityCopy
  words: Words
  onChanged: () => void
  onRetryAll: (reason: IndexIssueReason) => Promise<ActionResult>
}) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<GroupFiles>({ items: [], total: 0, loading: false, error: '' })
  const [busy, setBusy] = useState<Record<number, string>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [retryingAll, setRetryingAll] = useState(false)
  const request = useRef(0)
  const iw = issueWordsFor(lang)
  const text = copy.reasons[reason]
  const retryable = isRetryableReason(reason)

  const load = useCallback(
    async (offset: number) => {
      const id = ++request.current
      setFiles((current) => ({ ...current, loading: true, error: '' }))
      try {
        const page = await api.getDocumentIndexIssues(root, offset, reason)
        if (id !== request.current) return
        setFiles((current) => ({
          items: offset === 0 ? page.items : [...current.items, ...page.items],
          total: page.total,
          loading: false,
          error: '',
        }))
      } catch (error) {
        if (id !== request.current) return
        setFiles((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : iw.actionFailed,
        }))
      }
    },
    [api, root, reason, iw],
  )

  // The group's file list belongs to one folder; drop it when the folder or count changes
  // underneath it (a retry elsewhere, a new scan) and reload if it is open.
  useEffect(() => {
    request.current++
    setFiles({ items: [], total: 0, loading: false, error: '' })
    if (open) void load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, count])

  const remove = (issue: IndexIssue) =>
    setFiles((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== issue.id),
      total: Math.max(0, current.total - 1),
    }))

  const act = async (issue: IndexIssue, action: 'retry' | 'reveal' | 'exclude') => {
    setBusy((current) => ({ ...current, [issue.id]: action }))
    setErrors((current) => ({ ...current, [issue.id]: '' }))
    try {
      let result: ActionResult | undefined
      if (action === 'retry') result = await api.retryDocumentIndex(issue.id)
      else if (action === 'reveal') result = await api.revealDocumentIndexFile(issue.id)
      else {
        await api.excludeDocumentMemory(issue.path)
        result = { ok: true }
      }
      if (!result?.ok) {
        throw new Error(
          result?.error === 'paused'
            ? words.paused
            : result?.error === 'unavailable'
              ? copy.reasons.unavailable.title
              : result?.error || iw.actionFailed,
        )
      }
      if (action !== 'reveal') {
        remove(issue)
        onChanged()
      }
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [issue.id]: error instanceof Error ? error.message : iw.actionFailed,
      }))
    } finally {
      setBusy((current) => {
        const next = { ...current }
        delete next[issue.id]
        return next
      })
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && files.items.length === 0 && !files.loading) void load(0)
  }

  const retryAll = async () => {
    setRetryingAll(true)
    try {
      await onRetryAll(reason)
    } finally {
      setRetryingAll(false)
    }
  }

  return (
    <div className={`indexing-activity-group${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="indexing-activity-group-head"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>{text.title}</span>
        <strong>{formatCount(count, lang)}</strong>
        <span className="indexing-activity-chevron" aria-hidden>
          ›
        </span>
      </button>
      {open && (
        <div className="indexing-activity-group-body">
          <p>{text.hint}</p>
          {retryable && count > 1 && (
            <button
              type="button"
              className="indexing-activity-secondary"
              disabled={retryingAll}
              onClick={() => void retryAll()}
            >
              {retryingAll ? copy.retrying : `${copy.retryAll} (${formatCount(count, lang)})`}
            </button>
          )}
          {files.error && (
            <p className="indexing-activity-action-error" role="alert">
              {files.error}
            </p>
          )}
          <ul>
            {files.items.map((issue) => (
              <li key={issue.id} className="indexing-activity-file">
                <strong title={issue.path}>{issue.name}</strong>
                <div className="indexing-activity-file-actions">
                  {retryable && (
                    <button
                      type="button"
                      disabled={!!busy[issue.id]}
                      onClick={() => void act(issue, 'retry')}
                    >
                      {busy[issue.id] === 'retry' ? copy.retrying : iw.retry}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!!busy[issue.id]}
                    onClick={() => void act(issue, 'reveal')}
                  >
                    {iw.showInFolder}
                  </button>
                  <button
                    type="button"
                    disabled={!!busy[issue.id]}
                    onClick={() => void act(issue, 'exclude')}
                  >
                    {copy.exclude}
                  </button>
                </div>
                {errors[issue.id] && (
                  <p className="indexing-activity-action-error" role="alert">
                    {errors[issue.id]}
                  </p>
                )}
                {issue.error && (
                  <details className="indexing-activity-details">
                    <summary>{copy.details}</summary>
                    <code>{issue.error}</code>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {files.loading && <p>{iw.loading}</p>}
          {!files.loading && files.items.length < files.total && (
            <button
              type="button"
              className="indexing-activity-secondary"
              onClick={() => void load(files.items.length)}
            >
              {copy.showMore} ({files.total - files.items.length})
            </button>
          )}
        </div>
      )}
    </div>
  )
})
