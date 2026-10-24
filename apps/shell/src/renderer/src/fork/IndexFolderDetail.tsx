import { useContext, useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexedFolder } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { indexV2Words } from '../i18n/strings-index-v2'
import { formatBytes } from './index-file-log'
import { IndexFileBrowser } from './IndexFileBrowser'
import { IndexRuntime } from './IndexRuntime'
import { IndexingRulesStudio } from './IndexingRulesStudio'

export function IndexFolderDetail({
  api,
  folder,
  onChanged,
  onRemove,
  onClose,
}: {
  api: HomeApi
  folder: IndexedFolder
  onChanged: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { lang, dateLocale } = useI18n()
  const w = indexV2Words(lang)
  const runtime = useContext(IndexRuntime)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [size, setSize] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [filesOpen, setFilesOpen] = useState(false)
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
  return (
    <div
      className="ix-folder-detail"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <header>
        <strong title={folder.root}>{folder.root}</strong>
        <button type="button" className="ix-icon-btn" onClick={onClose} aria-label={w.close}>
          ×
        </button>
      </header>
      <dl className="ix-folder-facts">
        {[
          [w.total, folder.totalFiles],
          [w.ready, folder.readyFiles + (folder.releasedFiles ?? 0)],
          [w.pending, folder.waitingFiles ?? folder.pendingFiles],
          [w.error, folder.errorFiles],
          [w.skipped, folder.emptyFiles ?? 0],
          [w.size, size === null ? w.notRecorded : formatBytes(size, dateLocale)],
          [
            w.lastScan,
            folder.completedAt
              ? new Date(folder.completedAt).toLocaleString(dateLocale)
              : w.notRecorded,
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{typeof value === 'number' ? value.toLocaleString(dateLocale) : value}</dd>
          </div>
        ))}
      </dl>
      {folder.unavailable && (
        <p className="ix-note">
          {w.connection}:{' '}
          {runtime.offlineRoots?.find((source) => source.root === folder.root)?.since
            ? w.offlineSince.replace(
                '{date}',
                new Date(
                  runtime.offlineRoots.find((source) => source.root === folder.root)!.since,
                ).toLocaleString(dateLocale),
              )
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
      {folder.lastError && <p className="ix-note">{folder.lastError}</p>}
      {note && (
        <p className="ix-note" role="status">
          {note}
        </p>
      )}
      <div className="ix-folder-actions">
        <button
          type="button"
          className="ix-btn is-small"
          disabled={busy || folder.unavailable}
          onClick={() => void act(() => api.rescanIndexedFolder(folder.root))}
        >
          {folder.paused ? w.resumeFolder : w.scan}
        </button>
        {!folder.paused && (
          <button
            type="button"
            className="ix-btn is-small"
            disabled={busy || !api.pauseIndexedFolder}
            title={w.pauseHint}
            onClick={() => void act(() => api.pauseIndexedFolder!(folder.root))}
          >
            {w.pauseFolder}
          </button>
        )}
        <button
          type="button"
          className="ix-btn is-small"
          disabled={busy}
          aria-pressed={folder.priority}
          onClick={() =>
            void act(() => api.setIndexedFolderPriority(folder.root, !folder.priority))
          }
        >
          {w.priority}
        </button>
        <button
          type="button"
          className="ix-btn is-small"
          disabled={busy || folder.unavailable}
          onClick={() => void act(() => api.openFolderInFileManager(folder.root))}
        >
          {w.reveal}
        </button>
        <button
          type="button"
          className="ix-btn is-small"
          onClick={() => setRulesOpen((v) => !v)}
          aria-expanded={rulesOpen}
        >
          {w.rules}
        </button>
        <button
          type="button"
          className="ix-btn is-small"
          disabled={busy || folder.state === 'running'}
          onClick={onRemove}
        >
          {w.removeFolder}
        </button>
      </div>
      {folder.paused && <p className="ix-note">{w.pauseHint}</p>}
      {rulesOpen && <IndexingRulesStudio api={api} initialRoot={folder.root} />}
      <details className="ix-folder-history">
        <summary>{w.history}</summary>
        {folder.history.length ? (
          <ol>
            {folder.history.map((run) => (
              <li key={`${run.kind}:${run.endedAt}`}>
                <time>{new Date(run.endedAt).toLocaleString(dateLocale)}</time>
                <span>
                  {run.discovered.toLocaleString(dateLocale)} {w.files} ·{' '}
                  {run.enrolled.toLocaleString(dateLocale)} {w.ready} ·{' '}
                  {run.skipped.toLocaleString(dateLocale)} {w.skipped} ·{' '}
                  {run.errors.toLocaleString(dateLocale)} {w.error}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ix-quiet">{w.notRecorded}</p>
        )}
      </details>
      <button
        type="button"
        className="ix-link ix-folder-files-toggle"
        aria-expanded={filesOpen}
        onClick={() => setFilesOpen((v) => !v)}
      >
        {w.files} · {folder.totalFiles.toLocaleString(dateLocale)}
      </button>
      {filesOpen && (
        <IndexFileBrowser
          api={api}
          scope={{ root: folder.root }}
          revision={folder.totalFiles + folder.errorFiles + folder.pendingFiles}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}
