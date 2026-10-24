import { useContext, useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexedFolder } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { indexV2Words } from '../i18n/strings-index-v2'
import { formatBytes } from './index-file-log'
import { IndexRuntime } from './IndexRuntime'
import { IndexOverflow } from './IndexCard'
import { MenuItem, MenuSeparator } from './IndexMenu'
import { IconChevron } from './index-icons'
import { shortPath } from './index-screen-model'

/** What the folder panel has opened underneath the list: the folder's rules or its files. */
export type FolderExtra = 'rules' | 'files' | null

/**
 * One folder, in the same panel the file list uses: a header, what happened, a primary action
 * with everything else behind "…", and the facts as label / value rows.
 */
export function IndexFolderDetail({
  api,
  folder,
  onChanged,
  onRemove,
  onClose,
  extra,
  onExtra,
}: {
  api: HomeApi
  folder: IndexedFolder
  onChanged: () => void
  onRemove: () => void
  onClose: () => void
  extra: FolderExtra
  onExtra: (next: FolderExtra) => void
}) {
  const { lang, dateLocale } = useI18n()
  const w = indexV2Words(lang)
  const runtime = useContext(IndexRuntime)
  const [size, setSize] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (folder.sizeBytes !== undefined) {
      setSize(folder.sizeBytes)
      return
    }
    let alive = true
    void api
      .getIndexBrowserPage?.({ root: folder.root })
      .then((page) => {
        if (alive) setSize(page.sizeBytes)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [api, folder.root, folder.totalFiles, folder.sizeBytes])
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      const result = await work()
      if (
        result === false ||
        (result && typeof result === 'object' && 'ok' in result && !result.ok)
      )
        throw new Error('failed')
      onChanged()
    } catch {
      setNote(w.failed)
    } finally {
      setBusy(false)
    }
  }
  const name = folder.root.split(/[\\/]/).filter(Boolean).pop() ?? folder.root
  const since = runtime.offlineRoots?.find((source) => source.root === folder.root)?.since
  const num = (n: number) => n.toLocaleString(dateLocale)
  const facts: Array<[string, string]> = [
    [w.total, num(folder.totalFiles)],
    [w.ready, num(folder.readyFiles + (folder.releasedFiles ?? 0))],
    [w.pending, num(folder.waitingFiles ?? folder.pendingFiles)],
    [w.error, num(folder.errorFiles)],
    [w.skipped, num(folder.emptyFiles ?? 0)],
    [w.size, size === null ? w.notRecorded : formatBytes(size, dateLocale)],
  ]
  const toggle = (next: Exclude<FolderExtra, null>) => onExtra(extra === next ? null : next)
  return (
    <aside
      className="ix-detail ix-folder-detail"
      aria-label={`${w.folder}: ${name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <header>
        <div>
          <span className="ix-quiet">{w.folder}</span>
          <h3 title={folder.root}>{name}</h3>
        </div>
        <button type="button" className="ix-icon-btn" onClick={onClose} aria-label={w.close}>
          ×
        </button>
      </header>
      <p className="ix-detail-path" title={folder.root}>
        {shortPath(folder.root)}
      </p>
      <section className="ix-detail-section">
        <h4>{w.sectionHappened}</h4>
        {folder.unavailable && (
          <p className="ix-detail-reason">
            {w.connection}:{' '}
            {since
              ? w.offlineSince.replace('{date}', new Date(since).toLocaleString(dateLocale))
              : w.notRecorded}{' '}
            <button
              type="button"
              className="ix-link"
              onClick={() => void act(() => api.checkDocumentIndexSources!())}
            >
              {w.checkSource}
            </button>
          </p>
        )}
        {folder.paused && <p className="ix-detail-reason">{w.pauseHint}</p>}
        {folder.lastError && <p className="ix-detail-reason">{folder.lastError}</p>}
        <p className="ix-detail-reason">
          {w.lastScan}:{' '}
          {folder.completedAt
            ? new Date(folder.completedAt).toLocaleString(dateLocale)
            : w.notRecorded}
        </p>
        <details className="ix-folder-history">
          <summary>{w.history}</summary>
          {folder.history.length ? (
            <ol>
              {folder.history.map((run) => (
                <li key={`${run.kind}:${run.endedAt}`}>
                  <time>{new Date(run.endedAt).toLocaleString(dateLocale)}</time>
                  <span>
                    {num(run.discovered)} {w.files} · {num(run.enrolled)} {w.ready} ·{' '}
                    {num(run.skipped)} {w.skipped} · {num(run.errors)} {w.error}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="ix-quiet">{w.notRecorded}</p>
          )}
        </details>
      </section>
      <section className="ix-detail-section">
        <h4>{w.sectionActions}</h4>
        {note && (
          <p className="ix-note" role="status">
            {note}
          </p>
        )}
        <div className="ix-detail-actions">
          <button
            type="button"
            className="ix-btn is-primary is-small"
            disabled={busy || folder.unavailable}
            onClick={() => void act(() => api.rescanIndexedFolder(folder.root))}
          >
            {folder.paused ? w.resumeFolder : w.scan}
          </button>
          <button
            type="button"
            className="ix-btn is-small"
            disabled={busy || folder.unavailable}
            onClick={() => void act(() => api.openFolderInFileManager(folder.root))}
          >
            {w.reveal}
          </button>
          <IndexOverflow label={w.more}>
            {(close) => (
              <>
                {!folder.paused && (
                  <MenuItem
                    disabled={busy || !api.pauseIndexedFolder}
                    title={w.pauseHint}
                    onClick={() => {
                      close()
                      void act(() => api.pauseIndexedFolder!(folder.root))
                    }}
                  >
                    {w.pauseFolder}
                  </MenuItem>
                )}
                <MenuItem
                  checked={!!folder.priority}
                  disabled={busy}
                  onClick={() => {
                    close()
                    void act(() => api.setIndexedFolderPriority(folder.root, !folder.priority))
                  }}
                >
                  {w.priority}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close()
                    toggle('rules')
                  }}
                >
                  {w.rules}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  disabled={busy || folder.state === 'running'}
                  onClick={() => {
                    close()
                    onRemove()
                  }}
                >
                  {w.removeFolder}
                </MenuItem>
              </>
            )}
          </IndexOverflow>
        </div>
      </section>
      <section className="ix-detail-section">
        <h4>{w.sectionFacts}</h4>
        <dl className="ix-detail-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="ix-detail-row"
          aria-expanded={extra === 'files'}
          onClick={() => toggle('files')}
        >
          <span>
            {w.files} · {num(folder.totalFiles)}
          </span>
          <span className={`ix-chev${extra === 'files' ? ' is-open' : ''}`} aria-hidden="true">
            <IconChevron />
          </span>
        </button>
      </section>
    </aside>
  )
}
