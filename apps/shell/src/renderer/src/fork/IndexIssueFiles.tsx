import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssue } from '../../../main/document-memory/issues'
import { isRetryableReason, type IndexIssueReason } from '../../../main/document-memory/issues'
import { iconFor } from '../file-icons'
import { useI18n } from '../locale'
import { TEXT, EN } from './index-dashboard-i18n'
import { isIndexIssuePage, readIndexRequest } from './index-request'
import { shortPath } from './index-screen-model'
import { IconFolder, IconOpen, IconRetry } from './index-icons'

interface Bucket {
  items: IndexIssue[]
  total: number
}

const parentOf = (path: string): string => {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : path
}

const FileRow = memo(function FileRow({
  item,
  api,
  onChanged,
}: {
  item: IndexIssue
  api: HomeApi
  onChanged: () => void
}) {
  const { lang } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  const gone = !!item.deleted || item.reason === 'unavailable'
  const ocr = item.reason === 'no-text' && typeof api.enqueueScannedPdfsWithAgy === 'function'
  const canRetry = !gone && (ocr || isRetryableReason(item.reason))
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (ocr) await api.enqueueScannedPdfsWithAgy!([item.id], true)
      else await api.retryDocumentIndex(item.id)
    } catch {
      /* the list refreshes and shows what is still wrong */
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  return (
    <li className={`ix-file${gone ? ' is-gone' : ''}`} title={item.error || undefined}>
      <img className="ix-file-icon" src={iconFor(item.name)} alt="" width={20} height={20} />
      <span className="ix-file-text">
        <strong>{item.name}</strong>
        <span title={item.path}>{shortPath(parentOf(item.path), 52)}</span>
      </span>
      <span className="ix-file-actions">
        <button
          type="button"
          className="ix-icon-btn is-small"
          aria-label={`${s.fileOpen}: ${item.name}`}
          title={s.fileOpen}
          disabled={gone}
          onClick={() => void api.openPath(item.path)}
        >
          <IconOpen />
        </button>
        {canRetry && (
          <button
            type="button"
            className="ix-icon-btn is-small"
            aria-label={`${ocr ? s.fileOcr : s.fileRetry}: ${item.name}`}
            title={ocr ? s.fileOcr : s.fileRetry}
            disabled={busy}
            onClick={() => void retry()}
          >
            <IconRetry />
          </button>
        )}
        <button
          type="button"
          className="ix-icon-btn is-small"
          aria-label={`${s.fileReveal}: ${item.name}`}
          title={s.fileReveal}
          disabled={gone}
          onClick={() => void api.revealDocumentIndexFile(item.id)}
        >
          <IconFolder />
        </button>
      </span>
    </li>
  )
})

/**
 * The files behind one kind of trouble, as a plain list: type mark, name, where it lives, and three
 * quiet actions that appear on hover (open, try again or read with OCR, show in folder). The reason is
 * said once, by the group row above; nothing here repeats it.
 */
export function IndexIssueFiles({
  api,
  reasons,
  count,
  onChanged,
}: {
  api: HomeApi
  reasons: readonly IndexIssueReason[]
  /** the group's current count; a change reloads the first pages */
  count: number
  onChanged: () => void
}) {
  const { lang, dateLocale } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  const [buckets, setBuckets] = useState<Partial<Record<IndexIssueReason, Bucket>>>({})
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const alive = useRef(true)
  const ref = useRef(buckets)
  ref.current = buckets
  const key = reasons.join(',')

  const load = useCallback(
    async (reason: IndexIssueReason, append: boolean) => {
      const offset = append ? (ref.current[reason]?.items.length ?? 0) : 0
      const page = await readIndexRequest(
        () => api.getDocumentIndexIssues('*', offset, reason),
        isIndexIssuePage,
      )
      if (!alive.current) return
      setBuckets((prev) => ({
        ...prev,
        [reason]: {
          items: append ? [...(prev[reason]?.items ?? []), ...page.items] : page.items,
          total: page.total,
        },
      }))
    },
    [api],
  )

  useEffect(() => {
    alive.current = true
    setLoading(true)
    void Promise.all(key.split(',').map((r) => load(r as IndexIssueReason, false)))
      .then(() => alive.current && setFailed(false))
      .catch(() => alive.current && setFailed(true))
      .finally(() => alive.current && setLoading(false))
    return () => {
      alive.current = false
    }
  }, [key, count, load])

  const items = reasons.flatMap((r) => buckets[r]?.items ?? [])
  const total = reasons.reduce((n, r) => n + (buckets[r]?.total ?? 0), 0)
  const more = reasons.find((r) => (buckets[r]?.items.length ?? 0) < (buckets[r]?.total ?? 0))
  const refresh = () => {
    onChanged()
  }

  if (failed && items.length === 0)
    return (
      <p className="ix-note" role="status">
        {s.filesFailed}{' '}
        <button type="button" className="ix-link" onClick={() => void load(reasons[0]!, false)}>
          {s.retry}
        </button>
      </p>
    )
  if (items.length === 0)
    return loading ? <span className="ix-skel ix-skel-row" aria-busy="true" /> : null
  return (
    <div className="ix-files-wrap">
      <ul className="ix-files">
        {items.map((item) => (
          <FileRow key={item.id} item={item} api={api} onChanged={refresh} />
        ))}
      </ul>
      {more && (
        <button
          type="button"
          className="ix-link ix-files-more"
          onClick={() => void load(more, true).catch(() => setFailed(true))}
        >
          {s.filesMore.replace('{n}', (total - items.length).toLocaleString(dateLocale))}
        </button>
      )}
    </div>
  )
}
