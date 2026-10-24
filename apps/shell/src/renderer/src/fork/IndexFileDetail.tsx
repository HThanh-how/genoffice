import type { HomeApi } from '../../../shared/home-api'
import type { FileActions, FileItem } from './IndexFiles'
import { folderOf } from './IndexFiles'
import { formatBytes, deriveFileSteps, logWords } from './index-file-log'
import { liveOf } from './IndexFiles'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { activityCopy } from '../indexing-activity-copy'
import { indexV2Words } from '../i18n/strings-index-v2'
import { indexRowActions } from './index-row-state'

export function IndexFileDetail({
  api,
  item: initialItem,
  actions,
  now,
  onClose,
  onIgnorePath,
}: {
  api: HomeApi
  item: FileItem
  actions: FileActions
  now: IndexingNow | null
  onClose: () => void
  onIgnorePath: (path: string) => void
}) {
  const { lang, dateLocale } = useI18n()
  const w = indexV2Words(lang)
  const detail = initialItem.id <= 0 ? null : actions.details[initialItem.id]
  const item: FileItem = detail
    ? {
        ...initialItem,
        path: detail.path,
        name: detail.name,
        error: detail.error,
        status: detail.indexStatus ?? detail.status,
        reason: detail.indexStatus !== undefined ? detail.reason : initialItem.reason,
      }
    : initialItem
  const fileType = /\.([^.]+)$/.exec(item.name)?.[1]?.toUpperCase() ?? w.notRecorded
  const offline = !!item.offline || !!detail?.sourceOffline
  const busy = actions.busy.has(item.id)
  const availability = indexRowActions(
    { ...item, offline },
    liveOf(now, item.path)?.kind,
    false,
    false,
  )
  const date = (value?: number) =>
    value ? new Date(value).toLocaleString(dateLocale) : w.notRecorded
  const reason = offline
    ? { title: w.offline, hint: w.offlineHint }
    : item.reason
      ? activityCopy(lang).reasons[item.reason]
      : null
  const act = (label: string, run: () => unknown, disabled = false) => (
    <button
      type="button"
      className="ix-btn is-small"
      disabled={busy || disabled}
      onClick={() => void run()}
    >
      {label}
    </button>
  )
  return (
    <aside
      className="ix-detail"
      aria-label={`${w.details}: ${item.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <header>
        <div>
          <span className="ix-quiet">{w.details}</span>
          <h3>{item.name}</h3>
        </div>
        <button type="button" className="ix-icon-btn" aria-label={w.close} onClick={onClose}>
          ×
        </button>
      </header>
      <p className="ix-detail-path">{item.path}</p>
      {reason && (
        <p className="ix-detail-reason">
          <strong>{reason.title}</strong>
          <br />
          {reason.hint}
        </p>
      )}
      {item.error && !offline && <p className="ix-quiet">{item.error}</p>}
      <div className="ix-detail-actions">
        {act(w.open, () => actions.openFile(item), !availability.open)}
        {act(w.reveal, () => actions.reveal(item), offline)}
        {act(w.retry, () => actions.retry(item), item.id <= 0 || !availability.retry)}
        {act(
          w.ocr,
          () => actions.readNow(item),
          item.id <= 0 || !/\.pdf$/i.test(item.name) || offline,
        )}
        {act(w.copy, () => actions.copyPath(item))}
      </div>
      <details className="ix-detail-more">
        <summary>{w.more}</summary>
        <div className="ix-detail-actions">
          {act(w.later, () => actions.later(item), !availability.defer)}
          {act(w.stop, () => actions.stop(item), !availability.stop)}
          {act(w.copyName, () => actions.copyName(item))}
          {act(w.copyLog, () => actions.copyLog(item))}
          {act(w.exclude, () => onIgnorePath(item.path), !api.addIndexIgnore)}
          {act(w.excludeFolder, () => onIgnorePath(folderOf(item.path)), !api.addIndexIgnore)}
          {act(w.remove, () => actions.exclude(item), item.id <= 0)}
        </div>
      </details>
      {detail === undefined ? (
        <p role="status">{w.loading}</p>
      ) : detail === null ? (
        item.id <= 0 ? (
          <dl className="ix-detail-facts">
            {[
              [w.folder, folderOf(item.path)],
              [w.type, fileType],
              [w.size, w.notRecorded],
              [w.modified, date(item.mtimeMs)],
              [w.status, w['on-disk']],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="ix-quiet">{w.failed}</p>
        )
      ) : (
        <>
          <dl className="ix-detail-facts">
            {[
              [w.folder, folderOf(item.path)],
              [w.type, fileType],
              [
                w.size,
                detail.sizeBytes === undefined
                  ? w.notRecorded
                  : formatBytes(detail.sizeBytes, dateLocale),
              ],
              [w.modified, date(detail.mtimeMs)],
              [w.updated, date(detail.updatedAt)],
              [w.indexAttempts, w.notRecorded],
              [w.lastIndexAttempt, w.notRecorded],
              [
                w.status,
                w[(item.status ?? detail.status) as 'ready'] ??
                  (detail.status === 'text-only' ? w.pending : detail.status),
              ],
              [w.attempts, detail.localOcrAttempts?.toLocaleString(dateLocale) ?? w.notRecorded],
              [w.lastAttempt, date(detail.localOcrAttemptAt)],
              [
                w.ocrState,
                detail.ocrTiers?.map((t) => (t === 'local' ? w.local : w.cloud)).join(' · ') ||
                  w.notRecorded,
              ],
              [w.rotation, w.notRecorded],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {detail.pdf && (
              <div>
                <dt>OCR</dt>
                <dd>
                  {detail.pdf.ocrPages}/{detail.pdf.totalPages} ·{' '}
                  {detail.pdf.ocrChars.toLocaleString(dateLocale)} · {detail.pdf.ocrModel}
                </dd>
              </div>
            )}
          </dl>
          {detail.truncated && <p>{w.truncated}</p>}
          <label className="ix-detail-importance">
            {w.importance}
            <select
              className="idx-select"
              value={detail.importance?.override ?? 'auto'}
              disabled={busy}
              onChange={(e) =>
                void actions.setImportance(item, e.target.value as 'auto' | 'important' | 'low')
              }
            >
              <option value="auto">{w.auto}</option>
              <option value="important">{w.important}</option>
              <option value="low">{w.low}</option>
            </select>
          </label>
          {detail.importance?.reason && <p className="ix-quiet">{detail.importance.reason}</p>}
          <ol className="ix-detail-steps">
            {deriveFileSteps(detail, lang).map((step) => (
              <li key={step.key}>
                <strong>{logWords(lang)[step.key]}</strong> {step.text}
              </li>
            ))}
          </ol>
        </>
      )}
      {actions.detailFailures.has(item.id) && act(w.retry, () => actions.refreshDetail(item.id))}
    </aside>
  )
}
