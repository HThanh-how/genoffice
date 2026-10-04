import type { HomeApi, HomeIndexingActivity } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { useAgyOcrStatus } from './AgyOcrSettings'
import { activityLine } from './agy-ocr-strings'

/** Local indexing and remote OCR are separate queues; a remote wait is not a local stall. */
export function IndexPipeline({
  api,
  activity,
  now,
  paused,
  onTodo,
  onSettings,
}: {
  api: HomeApi
  activity: HomeIndexingActivity | null
  now: IndexingNow | null
  paused: boolean
  onTodo(): void
  onSettings(): void
}) {
  const { lang, dateLocale } = useI18n()
  const vi = lang === 'vi'
  const [ocr, refreshOcr, ocrFailed] = useAgyOcrStatus(api)
  const waiting = activity?.folderProgress?.pendingFiles ?? activity?.memory.pending ?? 0
  const busyFiles = new Map<string, string>()
  for (const item of now?.extracting ?? [])
    busyFiles.set(item.path, vi ? 'Đang đọc nội dung' : 'Reading content')
  for (const [path, progress] of Object.entries(now?.embedding ?? {}))
    if (now?.activeEmbeddingPath === undefined || now.activeEmbeddingPath === path)
      busyFiles.set(
        path,
        `${vi ? 'Chuẩn bị tìm kiếm' : 'Preparing search'} · ${progress.done.toLocaleString(dateLocale)} / ${progress.total.toLocaleString(dateLocale)}`,
      )
  const ocrStages = vi
    ? {
        quota: 'Kiểm tra hạn mức',
        rendering: 'Chuẩn bị trang',
        recognizing: 'Antigravity đang đọc',
        indexing: 'Lưu vào tìm kiếm',
      }
    : {
        quota: 'Checking quota',
        rendering: 'Preparing pages',
        recognizing: 'Antigravity is reading',
        indexing: 'Adding to search',
      }
  const localState = paused
    ? vi
      ? 'Đang tạm dừng'
      : 'Paused'
    : busyFiles.size
      ? vi
        ? 'Đang xử lý'
        : 'Working'
      : waiting > 0
        ? vi
          ? 'Đang chờ lượt xử lý'
          : 'Waiting for a turn'
        : vi
          ? 'Sẵn sàng'
          : 'Ready'
  return (
    <section
      className="idx-pipeline"
      aria-label={vi ? 'Hai luồng xử lý tài liệu' : 'Document processing queues'}
    >
      <article className="idx-lane">
        <div className="idx-lane-head">
          <strong>{vi ? 'Nội dung trên máy' : 'Local content'}</strong>
          <span className={`idx-lane-state${busyFiles.size && !paused ? ' is-working' : ''}`}>
            {localState}
          </span>
        </div>
        <p>
          {vi
            ? 'Tên và đường dẫn có thể tìm trước. Nội dung được bổ sung dần.'
            : 'Names and paths are searchable first. Content is added as it is read.'}
        </p>
        {busyFiles.size > 0 && (
          <ul className="idx-lane-files" aria-live="polite">
            {[...busyFiles].slice(0, 3).map(([path, status]) => (
              <li key={path} title={path}>
                <span>{path.split(/[\\/]/).pop()}</span>
                <small>{status}</small>
              </li>
            ))}
          </ul>
        )}
        <button className="idx-link" type="button" onClick={onTodo}>
          {vi ? 'Xem hàng đợi và tiến độ từng tệp' : 'View queue and file progress'}{' '}
          <span aria-hidden="true">→</span>
        </button>
      </article>
      <article className="idx-lane">
        <div className="idx-lane-head">
          <strong>{vi ? 'PDF quét · Antigravity' : 'Scanned PDFs · Antigravity'}</strong>
          <span className={`idx-lane-state${ocr?.running ? ' is-working' : ''}`}>
            {ocrFailed
              ? vi
                ? 'Chưa lấy được trạng thái'
                : 'Status unavailable'
              : ocr?.running && ocr.stage
                ? ocrStages[ocr.stage]
                : ocr
                  ? activityLine(lang, ocr.activity)
                  : vi
                    ? 'Đang lấy trạng thái…'
                    : 'Loading status…'}
          </span>
        </div>
        <p>
          {vi
            ? 'Chạy song song với index trên máy. OCR xong, nội dung được đưa vào tìm kiếm.'
            : 'Runs alongside local indexing. Returned text is added to search.'}
        </p>
        {ocr?.currentFile && (
          <div className="idx-lane-current" title={ocr.currentPath}>
            {ocr.currentFile}
          </div>
        )}
        {ocr && (
          <small className="idx-lane-count">
            {vi ? 'Chờ OCR' : 'Waiting for OCR'}: {ocr.filesWaiting.toLocaleString(dateLocale)} ·{' '}
            {vi ? 'Bạn đã chọn' : 'Manually queued'}:{' '}
            {(ocr.queuedDocuments ?? 0).toLocaleString(dateLocale)}
          </small>
        )}
        <div className="idx-lane-actions">
          <button className="idx-link" type="button" onClick={onSettings}>
            {vi ? 'Cài đặt OCR' : 'OCR settings'} <span aria-hidden="true">→</span>
          </button>
          {ocrFailed && (
            <button className="idx-link" type="button" onClick={refreshOcr}>
              {vi ? 'Thử lại' : 'Retry'}
            </button>
          )}
        </div>
      </article>
    </section>
  )
}
