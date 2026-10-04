import { appConfirm } from '../ui-feedback'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexFileDetail, IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { iconFor } from '../file-icons'
import { buildFileLog, deriveFileSteps, formatBytes, logWords } from './index-file-log'
import { isIndexFileDetail, isIndexingNow, readIndexRequest } from './index-request'
import { IndexMutationTimeout, runIndexMutation } from './index-mutation'
import { fileProgress, indexRowActions } from './index-row-state'

/** What the indexer is doing with one file right now. */
export type Live =
  | { kind: 'reading'; since: number; pages?: { done: number; total: number } }
  | { kind: 'embedding'; done: number; total: number; active?: boolean; paused?: boolean }
  | { kind: 'queued'; position: number; pages?: { done: number; total: number } }
  | { kind: 'paused' }

export function liveOf(now: IndexingNow | null, path: string): Live | null {
  if (!now) return null
  const pages = now.pages?.[path]
  const reading = now.extracting.find((entry) => entry.path === path)
  if (reading) return { kind: 'reading', since: reading.since, ...(pages ? { pages } : {}) }
  const vectors = now.embedding[path]
  if (vectors)
    return {
      kind: 'embedding',
      done: vectors.done,
      total: vectors.total,
      ...(now.activeEmbeddingPath !== undefined
        ? { active: now.activeEmbeddingPath === path && !now.paused }
        : {}),
      ...(now.paused ? { paused: true, active: false } : {}),
    }
  const position = now.positions[path]
  if (now.paused && position) return { kind: 'paused' }
  return position ? { kind: 'queued', position, ...(pages ? { pages } : {}) } : null
}

/** What the indexer is doing, refreshed while a list is on screen. */
export function useIndexingNow(api: HomeApi, active: boolean): IndexingNow | null {
  const [now, setNow] = useState<IndexingNow | null>(null)
  useEffect(() => {
    if (!active || !api.getIndexingNow) {
      setNow(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await readIndexRequest(() => api.getIndexingNow(), isIndexingNow)
          if (alive) setNow(next)
        } catch {
          // Do not keep claiming a file is live after the connection stops answering.
          if (alive) setNow(null)
        }
      }
      if (alive) timer = setTimeout(() => void tick(), 1500)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [api, active])
  return now
}

/** The folder a file is in, whichever separator the path uses. */
export const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

const clock = (since: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What a row needs to know about a file, whichever list it comes from. */
export interface FileItem {
  id: number
  path: string
  name: string
  status?: string
  reason?: IndexIssueReason
  error?: string
  progress?: { kind: 'ocr' | 'chunks'; done: number; total: number }
  deleted?: boolean
  offline?: boolean
}

const EN = {
  reading: 'Reading · {t}',
  readingPages: 'Reading · {t} · page {d}/{p}',
  queuedPages: 'Next in line: {n} · {d}/{p} pages read',
  embedding: 'Building search vectors {d}/{n}',
  queued: 'Next in line: {n}',
  pausedNow: 'Paused for now',
  done: 'Done',
  retry: 'Try again',
  readFirst: 'Read this one first',
  reread: 'Read again',
  readNow: 'Read with Antigravity now',
  readPicked: 'Read {n} selected files now',
  clearPicked: 'Clear selection',
  copyLog: 'Copy log',
  copied: 'Copied.',
  reveal: 'Show in folder',
  openFile: 'Open file',
  stop: 'Stop reading',
  later: 'Read later',
  deferred: 'Moved to the end of the line.',
  stopped: 'Stopped. Use Try again to read it later.',
  copyPath: 'Copy path',
  copyName: 'Copy file name',
  excludeFile: 'Do not index this file',
  excluded: 'It will not be indexed. You can bring it back in Settings → Index.',
  selectFile: 'Select (to read several together)',
  selectGroup: 'Select all in this list',
  couldNotOpen: 'Could not open this file.',
  moreActions: 'More actions',
  actionFailed: 'Could not complete this action. Try again.',
  loading: 'Loading…',
  detailFailed: 'Could not load file details. Close and reopen to try again.',
  readDone: 'Read. It can be searched now.',
  readEmpty: 'Read, but there is no text in it: it is a scan. Use “Read with Antigravity”.',
  indexOff: 'Indexing is switched off. Turn it on in the index settings.',
  ocrConfirm:
    'Read this scanned PDF now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
  ocrIndexed: 'Its pages were already read; the text is in the index now.',
  ocrStarted: 'It is a scan: reading it with Antigravity…',
  ocrDone: 'Read {n} pages. It is searchable shortly.',
  ocrFailed: 'Could not read: {e}',
  path: 'Path',
  okTag: 'Indexed',
  fileInfo: 'File information & technical details',
  readingAgy: 'Antigravity is reading this file…',
  runningHint: 'The result updates here when processing finishes. You can keep working.',
  ocrPicked: 'OCR {n} selected scans',
  excludePicked: 'Remove selected files from index',
  trashPicked: 'Move selected files to Recycle Bin',
  laterPicked: 'Read selected files later',
  stopPicked: 'Stop selected files',
  copyPicked: 'Copy selected paths',
  ocrQueued: 'Queued for manual OCR. Processing continues in the background.',
  readQueued: 'Queued for priority reading. Processing continues in the background.',
  ocrNotQueued:
    'Already queued, already read, or not available for OCR. Check Index settings for its current status.',
  unknownOutcome:
    'The app did not confirm this action in time. It may still finish. Check the file status before trying again.',
  requesting: 'Sending request…',
  ocrWaiting: 'OCR queued · waiting for its turn',
  ocrBlocked: 'OCR queued · {reason}',
  ocrError: 'OCR could not finish · {reason}',
  refreshDetail: 'Refresh details',
  copyFailed: 'Could not copy. Allow clipboard access and try again.',
  waitingLocal: 'Queued · waiting to be read',
  waitingVectors: 'Waiting for search vectors · {d}/{n}',
}
export type FileWords = typeof EN
const VI: FileWords = {
  reading: 'Đang đọc · {t}',
  readingPages: 'Đang đọc · {t} · trang {d}/{p}',
  queuedPages: 'Hàng chờ thứ {n} · đã đọc {d}/{p} trang',
  embedding: 'Đang lập vector tìm kiếm {d}/{n}',
  queued: 'Hàng chờ thứ {n}',
  pausedNow: 'Đang tạm dừng',
  done: 'Xong',
  retry: 'Thử lại',
  readFirst: 'Đọc tệp này trước',
  reread: 'Đọc lại',
  readNow: 'Đọc bằng Antigravity ngay',
  readPicked: 'Đọc ngay {n} tệp đã chọn',
  clearPicked: 'Bỏ chọn',
  copyLog: 'Sao chép nhật ký',
  copied: 'Đã sao chép.',
  reveal: 'Mở thư mục chứa tệp',
  openFile: 'Mở tệp',
  stop: 'Dừng đọc',
  later: 'Đọc sau',
  deferred: 'Đã đẩy xuống cuối hàng chờ.',
  stopped: 'Đã dừng. Bấm Thử lại để đọc sau.',
  copyPath: 'Sao chép đường dẫn',
  copyName: 'Sao chép tên tệp',
  excludeFile: 'Không index tệp này',
  excluded: 'Tệp sẽ không được index. Muốn lấy lại: Cài đặt → Chỉ mục.',
  selectFile: 'Chọn (để đọc nhiều tệp cùng lúc)',
  selectGroup: 'Chọn tất cả trong danh sách này',
  couldNotOpen: 'Không mở được tệp này.',
  moreActions: 'Thao tác khác',
  actionFailed: 'Không thực hiện được thao tác này. Hãy thử lại.',
  loading: 'Đang tải…',
  detailFailed: 'Chưa tải được chi tiết tệp. Đóng rồi mở lại để thử lần nữa.',
  readDone: 'Đã đọc xong, tìm được rồi.',
  readEmpty: 'Đã đọc nhưng không có chữ: đây là bản quét. Dùng “Đọc bằng Antigravity”.',
  indexOff: 'Đang tắt index. Bật lại trong cài đặt chỉ mục.',
  ocrConfirm:
    'Đọc ngay tệp PDF quét này bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  ocrIndexed: 'Các trang đã được đọc từ trước; chữ đã vào chỉ mục.',
  ocrStarted: 'Đây là bản quét: đang đọc bằng Antigravity…',
  ocrDone: 'Đã đọc {n} trang. Lát nữa là tìm được.',
  ocrFailed: 'Không đọc được: {e}',
  path: 'Đường dẫn',
  okTag: 'Đã index',
  fileInfo: 'Thông tin tệp & chi tiết kỹ thuật',
  readingAgy: 'Antigravity đang đọc tệp này…',
  runningHint: 'Kết quả sẽ cập nhật ở đây khi xử lý xong. Bạn có thể tiếp tục làm việc.',
  ocrPicked: 'OCR {n} bản quét đã chọn',
  excludePicked: 'Gỡ tệp đã chọn khỏi chỉ mục',
  trashPicked: 'Chuyển tệp đã chọn vào thùng rác',
  laterPicked: 'Đọc tệp đã chọn sau',
  stopPicked: 'Dừng các tệp đã chọn',
  copyPicked: 'Chép đường dẫn đã chọn',
  ocrQueued: 'Đã xếp OCR thủ công. Tiếp tục xử lý nền.',
  readQueued: 'Đã ưu tiên vào hàng chờ. Tiếp tục xử lý nền.',
  ocrNotQueued:
    'Tệp đã trong hàng chờ, đã đọc hoặc chưa thể OCR. Xem trạng thái trong cài đặt chỉ mục.',
  unknownOutcome:
    'Ứng dụng chưa xác nhận kịp thao tác này; có thể vẫn đang hoàn tất. Kiểm tra trạng thái tệp trước khi thử lại.',
  requesting: 'Đang gửi yêu cầu…',
  ocrWaiting: 'Đã xếp OCR · đang chờ lượt',
  ocrBlocked: 'Đã xếp OCR · {reason}',
  ocrError: 'OCR chưa hoàn tất · {reason}',
  refreshDetail: 'Cập nhật chi tiết',
  copyFailed: 'Chưa sao chép được. Cho phép truy cập bộ nhớ tạm rồi thử lại.',
  waitingLocal: 'Trong hàng chờ · chờ đọc nội dung',
  waitingVectors: 'Chờ lập vector tìm kiếm · {d}/{n}',
}
export const fileWords = (lang: string): FileWords => (lang === 'vi' ? VI : EN)

const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)
export const IRetry = () => (
  <Svg>
    <path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3" />
    <path d="M13.4 2.2v3h-3" />
  </Svg>
)
export const IChevron = () => (
  <Svg>
    <path d="M6 3.6 10.4 8 6 12.4" />
  </Svg>
)
const ICopy = () => (
  <Svg>
    <rect x="5.2" y="5.2" width="8" height="8" rx="1.6" />
    <path d="M10.8 5.2V3.8a1.4 1.4 0 0 0-1.4-1.4H3.8a1.4 1.4 0 0 0-1.4 1.4v5.6a1.4 1.4 0 0 0 1.4 1.4h1.4" />
  </Svg>
)
const IFolder = () => (
  <Svg>
    <path d="M2.2 4.6a1.4 1.4 0 0 1 1.4-1.4h2.5l1.4 1.6h4.9a1.4 1.4 0 0 1 1.4 1.4v5.2a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4z" />
  </Svg>
)
const IOpen = () => (
  <Svg>
    <path d="M9.2 2.6h4.2v4.2M13.4 2.6 7.2 8.8" />
    <path d="M11.6 9.4v2.8a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V5.6a1.2 1.2 0 0 1 1.2-1.2h2.8" />
  </Svg>
)
const ILater = () => (
  <Svg>
    <path d="M8 3v7.2M4.8 7.4 8 10.6l3.2-3.2M3.4 13h9.2" />
  </Svg>
)
const IStop = () => (
  <Svg>
    <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.6" />
  </Svg>
)
const ISpark = () => (
  <Svg>
    <path d="M8 1.8l1.4 4.1 4.1 1.4-4.1 1.4L8 12.8 6.6 8.7 2.5 7.3l4.1-1.4z" />
  </Svg>
)

export function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="ixp-icon"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Progress({ progress }: { progress: NonNullable<FileItem['progress']> }) {
  const { lang } = useI18n()
  const count = fileProgress(progress.done, progress.total)
  if (!count) return null
  const unit =
    progress.kind === 'ocr'
      ? lang === 'vi'
        ? 'trang'
        : 'pages'
      : lang === 'vi'
        ? 'đoạn'
        : 'blocks'
  const label = `${count.done}/${count.total} ${unit}`
  const percent = Math.round((count.done / count.total) * 100)
  return (
    <span
      className="ixp-progress"
      title={label}
      aria-label={label}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={count.total}
      aria-valuenow={count.done}
    >
      <span className="ixp-bar">
        <i style={{ width: `${Math.max(percent, 3)}%` }} />
      </span>
      <span className="ixp-progress-n">{label}</span>
    </span>
  )
}

/** Shared behaviour of every file list: open a file's log, copy it, retry, read now. */
export function useFileActions(
  api: HomeApi,
  reasonTitle: (reason: IndexIssueReason) => string,
  onChanged: () => void,
  afterChange: (item: FileItem) => Promise<void> | void,
) {
  const { lang, dateLocale } = useI18n()
  const w = fileWords(lang)
  const [open, setOpen] = useState<number | null>(null)
  const [details, setDetails] = useState<Record<number, IndexFileDetail | null>>({})
  const [detailFailures, setDetailFailures] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const busyIds = useRef(new Set<number>())
  const [readingAgy] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const [feedback, setFeedback] = useState<Record<number, { text: string; at: number }>>({})
  const feedbackTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const detailRequests = useRef(new Map<number, number>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const say = useCallback((text: string) => {
    setNote(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNote(''), 4000)
  }, [])
  const acknowledge = (ids: number[], text: string) => {
    const at = Date.now()
    setFeedback((current) => {
      const next = { ...current }
      for (const id of ids) next[id] = { text, at }
      return next
    })
    for (const id of ids) {
      const previous = feedbackTimers.current.get(id)
      if (previous) clearTimeout(previous)
      feedbackTimers.current.set(
        id,
        setTimeout(() => {
          feedbackTimers.current.delete(id)
          setFeedback((current) => {
            const next = { ...current }
            if (next[id]?.at === at) delete next[id]
            return next
          })
        }, 6000),
      )
    }
  }
  useEffect(
    () => () => {
      for (const timeout of feedbackTimers.current.values()) clearTimeout(timeout)
    },
    [],
  )

  const detailOf = async (id: number, force = false): Promise<IndexFileDetail | null> => {
    if (!force && id in details && !detailFailures.has(id)) return details[id] ?? null
    const request = (detailRequests.current.get(id) ?? 0) + 1
    detailRequests.current.set(id, request)
    try {
      const got = await readIndexRequest(() => api.getIndexFileDetail(id), isIndexFileDetail)
      if (detailRequests.current.get(id) !== request) return got
      setDetails((current) => ({ ...current, [id]: got }))
      setDetailFailures((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      return got
    } catch {
      if (detailRequests.current.get(id) !== request) return null
      setDetails((current) => ({ ...current, [id]: current[id] ?? null }))
      setDetailFailures((current) => new Set(current).add(id))
      return null
    }
  }
  useEffect(() => {
    if (open === null) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      if (document.visibilityState !== 'hidden') {
        const request = (detailRequests.current.get(open) ?? 0) + 1
        detailRequests.current.set(open, request)
        try {
          const next = await readIndexRequest(() => api.getIndexFileDetail(open), isIndexFileDetail)
          if (!alive || detailRequests.current.get(open) !== request) return
          setDetails((current) =>
            JSON.stringify(current[open]) === JSON.stringify(next)
              ? current
              : { ...current, [open]: next },
          )
          setDetailFailures((current) => {
            const next = new Set(current)
            next.delete(open)
            return next
          })
        } catch {
          if (alive) setDetailFailures((current) => new Set(current).add(open))
        }
      }
      if (alive) timer = setTimeout(() => void refresh(), 3000)
    }
    timer = setTimeout(() => void refresh(), 3000)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, open])
  const toggle = (item: FileItem) => {
    const next = open === item.id ? null : item.id
    setOpen(next)
    if (open !== null && open !== next) {
      setDetails((current) => {
        const { [open]: _closed, ...rest } = current
        return rest
      })
      setDetailFailures((current) => {
        const nextFailures = new Set(current)
        nextFailures.delete(open)
        return nextFailures
      })
    }
    if (next !== null) void detailOf(next)
  }
  const withBusy = async (id: number, work: () => Promise<void>) => {
    if (busyIds.current.has(id)) return
    busyIds.current.add(id)
    setBusy((current) => new Set(current).add(id))
    try {
      await work()
    } catch (error) {
      say(error instanceof IndexMutationTimeout ? w.unknownOutcome : w.actionFailed)
    } finally {
      busyIds.current.delete(id)
      setBusy((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }
  const settle = async (item: FileItem) => {
    void Promise.resolve()
      .then(() => afterChange(item))
      .catch(() => {})
    onChanged()
    if (open === item.id) {
      void detailOf(item.id, true)
    }
  }
  const copyLog = (item: FileItem) =>
    withBusy(item.id, async () => {
      const detail = await detailOf(item.id)
      const text = detail
        ? buildFileLog(detail, lang, dateLocale, item.reason ? reasonTitle(item.reason) : undefined)
        : `${item.path}\n${item.error ?? ''}`
      try {
        await runIndexMutation(() => navigator.clipboard.writeText(text))
        say(w.copied)
      } catch (error) {
        say(error instanceof IndexMutationTimeout ? w.unknownOutcome : w.copyFailed)
      }
    })
  const retry = (item: FileItem) =>
    withBusy(item.id, async () => {
      if (!api.enqueueDocumentIndex) {
        say(w.actionFailed)
        return
      }
      const result = await runIndexMutation(() => api.enqueueDocumentIndex!([item.id]))
      if (!result.error && result.queued > 0) acknowledge([item.id], w.readQueued)
      say(
        result.error
          ? fill(w.ocrFailed, { e: result.error })
          : result.queued > 0
            ? w.readQueued
            : w.actionFailed,
      )
      await settle(item)
    })
  const stop = (item: FileItem) =>
    withBusy(item.id, async () => {
      if (api.cancelScannedPdfsWithAgy)
        await runIndexMutation(() => api.cancelScannedPdfsWithAgy!([item.id]))
      const result = await runIndexMutation(() => api.stopIndexFile(item.id))
      if (result.ok) acknowledge([item.id], w.stopped)
      say(result.ok ? w.stopped : fill(w.ocrFailed, { e: result.error ?? '' }))
      await settle(item)
    })
  const later = (item: FileItem) =>
    withBusy(item.id, async () => {
      const result = await runIndexMutation(() => api.deferIndexFile(item.id))
      if (result.ok) acknowledge([item.id], w.deferred)
      say(result.ok ? w.deferred : fill(w.ocrFailed, { e: result.error ?? '' }))
      await settle(item)
    })
  const openFile = (item: FileItem) =>
    withBusy(item.id, async () => {
      const result = await runIndexMutation(() => api.documentMemoryOpen(item.id))
      if (!result?.ok) say(w.couldNotOpen)
    })
  const reveal = (item: FileItem) =>
    withBusy(item.id, async () => {
      await runIndexMutation(() => api.revealDocumentIndexFile(item.id))
    })
  const copyPath = (item: FileItem) =>
    withBusy(item.id, async () => {
      try {
        await runIndexMutation(() => navigator.clipboard.writeText(item.path))
        say(w.copied)
      } catch (error) {
        say(error instanceof IndexMutationTimeout ? w.unknownOutcome : w.copyFailed)
      }
    })
  const copyName = (item: FileItem) =>
    withBusy(item.id, async () => {
      try {
        await runIndexMutation(() => navigator.clipboard.writeText(item.name))
        say(w.copied)
      } catch (error) {
        say(error instanceof IndexMutationTimeout ? w.unknownOutcome : w.copyFailed)
      }
    })
  const exclude = (item: FileItem) =>
    withBusy(item.id, async () => {
      try {
        if (api.cancelScannedPdfsWithAgy)
          await runIndexMutation(() => api.cancelScannedPdfsWithAgy!([item.id]))
        await runIndexMutation(() => api.excludeDocumentMemory(item.path))
        say(w.excluded)
      } catch (error) {
        say(
          error instanceof IndexMutationTimeout
            ? w.unknownOutcome
            : fill(w.ocrFailed, { e: error instanceof Error ? error.message : '' }),
        )
      }
      await settle(item)
    })
  const readNow = (item: FileItem) =>
    withBusy(item.id, async () => {
      const consent =
        lang === 'vi'
          ? 'Đọc PDF quét này bằng Antigravity ngay? Các trang được gửi tới Antigravity. OCR thủ công bỏ qua ngân sách tự động, giới hạn tệp mỗi ngày và phần hạn mức dự phòng của GenOffice; vẫn chịu giới hạn của Antigravity.'
          : 'Read this scanned PDF with Antigravity now? Its pages are sent to Antigravity. Manual OCR ignores GenOffice’s automatic budgets, daily cap and quota reserves; Antigravity’s own limits still apply.'
      if (!(await appConfirm(consent))) return
      if (api.enqueueScannedPdfsWithAgy) {
        const result = await runIndexMutation(() => api.enqueueScannedPdfsWithAgy!([item.id], true))
        if (!result.error && result.queued > 0) acknowledge([item.id], w.ocrWaiting)
        say(
          result.error
            ? fill(w.ocrFailed, { e: result.error })
            : result.queued > 0
              ? w.ocrQueued
              : w.ocrNotQueued,
        )
      } else {
        say(w.actionFailed)
      }
      await settle(item)
    })
  return {
    open,
    toggle,
    details,
    detailFailures,
    busy,
    readingAgy,
    note,
    say,
    feedback,
    acknowledge,
    refreshDetail: (id: number) => detailOf(id, true),
    copyLog,
    copyPath,
    copyName,
    exclude,
    openFile,
    reveal,
    retry,
    stop,
    later,
    readNow,
  }
}

export type FileActions = ReturnType<typeof useFileActions>

interface MenuEntry {
  label: string
  icon: ReactNode
  run: () => void
  disabled?: boolean
  separatorBefore?: boolean
}

/** The right-click menu of a file row: the same actions as the icons, plus copy path. */
function FileMenu({
  at,
  entries,
  onClose,
  id,
  label,
  trigger,
}: {
  at: { x: number; y: number }
  entries: MenuEntry[]
  onClose: () => void
  id: string
  label: string
  trigger: HTMLElement | null
}) {
  const ref = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState(at)
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    // keep the menu inside the window
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - box.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - box.height - 4)),
    })
    ref.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true })
  }, [at])
  useEffect(() => {
    const away = (event: Event) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !(trigger?.classList.contains('ixp-more') && trigger.contains(event.target as Node))
      )
        onClose()
    }
    const scrollAway = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', away)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', scrollAway, true)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', scrollAway, true)
    }
  }, [onClose, trigger])
  return createPortal(
    <ul
      ref={ref}
      id={id}
      className="ixp-menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        )
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus({ preventScroll: true })
        buttons[next]?.scrollIntoView({ block: 'nearest' })
      }}
    >
      {entries.map((entry) => (
        <li key={entry.label} role="none">
          {entry.separatorBefore && <div className="ixp-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.run()
            }}
          >
            {entry.icon}
            {entry.label}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  )
}

/** One file: icon, name, cause, progress and icon actions; the name opens its log. */
export function FileRow({
  item,
  actions,
  status,
  live = null,
  finished = false,
  picked = false,
  pickedCount = 0,
  onPick,
  onReadPicked,
  onOcrPicked,
  onExcludePicked,
  onTrashPicked,
  onLaterPicked,
  onStopPicked,
  onCopyPicked,
  ocrPickedCount = 0,
  readPickedCount = pickedCount,
  ocrStage,
  ocrQueued = false,
  ocrWaitReason,
  ocrProgress,
  ocrError,
  onClearPicked,
  onSelectGroup,
}: {
  item: FileItem
  actions: FileActions
  /** this file is part of the selection */
  picked?: boolean
  pickedCount?: number
  /** a click with Ctrl/Cmd or Shift; a plain click clears the pick */
  onPick?: (item: FileItem, mode: 'toggle' | 'range' | 'clear') => void
  onReadPicked?: () => void
  onOcrPicked?: () => void
  onExcludePicked?: () => void
  onTrashPicked?: () => void
  onLaterPicked?: () => void
  onStopPicked?: () => void
  onCopyPicked?: () => void
  ocrPickedCount?: number
  readPickedCount?: number
  ocrStage?: 'quota' | 'rendering' | 'recognizing' | 'indexing'
  ocrQueued?: boolean
  ocrWaitReason?: string
  ocrProgress?: { done: number; total: number }
  ocrError?: string
  onClearPicked?: () => void
  /** pick every file of the list this row is in */
  onSelectGroup?: () => void
  api: HomeApi
  /** a short tag shown instead of the cause (search results) */
  status?: string
  /** what the indexer is doing with it now */
  live?: Live | null
  /** it has just been read: shown green for a moment, then removed by the list */
  finished?: boolean
}) {
  const { lang, dateLocale } = useI18n()
  const w = fileWords(lang)
  const lw = logWords(lang)
  const isOpen = actions.open === item.id
  const busy = actions.busy.has(item.id)
  const readingAgy = !!ocrStage || actions.readingAgy.has(item.id)
  const ocrText = ocrStage
    ? (lang === 'vi'
        ? {
            quota: 'OCR · đang kiểm tra hạn mức',
            rendering: 'OCR · chuẩn bị ảnh trang',
            recognizing: 'OCR · Antigravity đang đọc',
            indexing: 'OCR · đang lưu văn bản',
          }
        : {
            quota: 'OCR · checking quota',
            rendering: 'OCR · preparing page images',
            recognizing: 'OCR · Antigravity is reading',
            indexing: 'OCR · saving text',
          })[ocrStage]
    : w.readingAgy
  const detail = actions.details[item.id]
  const available = indexRowActions(
    item,
    live?.kind === 'embedding' && live.active === false ? 'queued' : live?.kind,
    ocrQueued,
    readingAgy,
  )
  const retryable = available.retry
  const liveText =
    live?.kind === 'reading'
      ? live.pages
        ? fill(w.readingPages, { t: clock(live.since), d: live.pages.done, p: live.pages.total })
        : fill(w.reading, { t: clock(live.since) })
      : live?.kind === 'embedding'
        ? live.paused
          ? `${w.pausedNow} · ${live.done}/${live.total}`
          : fill(live.active === false ? w.waitingVectors : w.embedding, {
              d: live.done,
              n: live.total,
            })
        : live?.kind === 'queued'
          ? live.pages
            ? fill(w.queuedPages, { n: live.position, d: live.pages.done, p: live.pages.total })
            : fill(w.queued, { n: live.position })
          : live?.kind === 'paused'
            ? w.pausedNow
            : ''
  const working =
    !item.offline &&
    (live?.kind === 'reading' || (live?.kind === 'embedding' && live.active !== false))
  // Issue groups explain the cause; rows identify where each file is stored.
  const sub = item.reason ? folderOf(item.path) : item.error
  const issueHint =
    item.reason && !['waiting', 'no-text', 'empty'].includes(item.reason)
      ? activityCopy(lang).reasons[item.reason].hint
      : undefined
  const interrupted = /^Stopped by you\./.test(item.error ?? '')
  const description = item.offline
    ? lang === 'vi'
      ? 'Ổ đang ngoại tuyến · chỉ mục đã lưu được giữ lại'
      : 'Source offline · cached index retained'
    : interrupted && !working && !readingAgy
      ? w.stopped
      : finished
        ? w.done
        : busy
          ? w.requesting
          : (readingAgy || working ? (readingAgy ? ocrText : liveText) : '') ||
            actions.feedback[item.id]?.text ||
            (readingAgy
              ? ocrText
              : ocrQueued
                ? ocrWaitReason
                  ? fill(w.ocrBlocked, { reason: ocrWaitReason })
                  : w.ocrWaiting
                : liveText) ||
            (ocrError
              ? fill(w.ocrError, { reason: ocrError })
              : (status ??
                (item.reason === 'waiting'
                  ? item.progress?.kind === 'chunks'
                    ? fill(w.waitingVectors, { d: item.progress.done, n: item.progress.total })
                    : w.waitingLocal
                  : isOpen
                    ? ''
                    : (issueHint ?? sub))))
  const stoppable = available.stop
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuId = useId()
  const detailId = useId()
  const mainRef = useRef<HTMLButtonElement>(null)
  const menuTrigger = useRef<HTMLElement | null>(null)
  const closeMenu = useCallback(() => {
    setMenu(null)
    if (menuTrigger.current?.isConnected) menuTrigger.current.focus({ preventScroll: true })
  }, [])
  const showMenu = (trigger: HTMLElement, at?: { x: number; y: number }) => {
    menuTrigger.current = trigger
    const box = trigger.getBoundingClientRect()
    setMenu(
      at && Number.isFinite(at.x) && Number.isFinite(at.y)
        ? at
        : { x: box.left, y: box.bottom + 4 },
    )
  }
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    if (onPick && !picked) {
      onPick(item, 'clear')
      onPick(item, 'toggle')
    }
    const trigger = (event.target as Element).closest<HTMLElement>('button, input')
    showMenu(trigger ?? mainRef.current ?? (event.currentTarget as HTMLElement), {
      x: event.clientX,
      y: event.clientY,
    })
  }
  const bulk = picked && pickedCount > 1
  const entries: MenuEntry[] = bulk
    ? [
        {
          label: fill(w.readPicked, { n: readPickedCount }),
          icon: <IRetry />,
          disabled: busy || !onReadPicked,
          run: () => onReadPicked?.(),
        },
        {
          label: fill(w.ocrPicked, { n: ocrPickedCount }),
          icon: <ISpark />,
          disabled: busy || !onOcrPicked || ocrPickedCount === 0,
          run: () => onOcrPicked?.(),
        },
        {
          label: w.laterPicked,
          icon: <ILater />,
          disabled: busy || !onLaterPicked,
          run: () => onLaterPicked?.(),
        },
        {
          label: w.stopPicked,
          icon: <IStop />,
          disabled: busy || !onStopPicked,
          run: () => onStopPicked?.(),
        },
        {
          label: w.copyPicked,
          icon: <ICopy />,
          disabled: !onCopyPicked,
          run: () => onCopyPicked?.(),
        },
        {
          label: w.excludePicked,
          icon: <IStop />,
          separatorBefore: true,
          disabled: busy || !onExcludePicked,
          run: () => onExcludePicked?.(),
        },
        {
          label: w.trashPicked,
          icon: <IStop />,
          disabled: busy || !onTrashPicked,
          run: () => onTrashPicked?.(),
        },
        {
          label: w.clearPicked,
          icon: <IStop />,
          disabled: !onClearPicked,
          run: () => onClearPicked?.(),
        },
      ]
    : [
        {
          label: w.openFile,
          icon: <IOpen />,
          disabled: busy || !available.open,
          run: () => void actions.openFile(item),
        },
        {
          label: w.reveal,
          icon: <IFolder />,
          disabled: busy || item.offline,
          run: () => void actions.reveal(item),
        },
        ...(available.ocr
          ? [
              {
                label: w.readNow,
                icon: <ISpark />,
                disabled: busy || readingAgy,
                separatorBefore: true,
                run: () => void actions.readNow(item),
              },
            ]
          : []),
        ...(retryable
          ? [
              {
                label:
                  item.reason === 'waiting'
                    ? w.readFirst
                    : item.status === 'ready'
                      ? w.reread
                      : w.retry,
                icon: <IRetry />,
                separatorBefore: item.reason !== 'no-text',
                disabled: busy,
                run: () => void actions.retry(item),
              },
            ]
          : []),
        ...(stoppable
          ? [
              ...(available.defer
                ? [
                    {
                      label: w.later,
                      separatorBefore:
                        !retryable && item.status !== 'ready' && item.reason !== 'no-text',
                      icon: <ILater />,
                      disabled: busy,
                      run: () => void actions.later(item),
                    },
                  ]
                : []),
              {
                label: w.stop,
                icon: <IStop />,
                disabled: busy,
                run: () => void actions.stop(item),
              },
            ]
          : []),
        {
          label: w.copyPath,
          icon: <ICopy />,
          separatorBefore: true,
          disabled: busy,
          run: () => void actions.copyPath(item),
        },
        {
          label: w.copyName,
          icon: <ICopy />,
          disabled: busy,
          run: () => void actions.copyName(item),
        },
        {
          label: w.copyLog,
          icon: <ICopy />,
          disabled: busy,
          run: () => void actions.copyLog(item),
        },
        ...(onPick
          ? [
              {
                label: w.selectFile,
                icon: <IRetry />,
                separatorBefore: true,
                run: () => onPick(item, 'toggle'),
              },
              ...(onSelectGroup
                ? [{ label: w.selectGroup, icon: <IRetry />, run: () => onSelectGroup() }]
                : []),
            ]
          : []),
        {
          label: w.excludeFile,
          separatorBefore: true,
          icon: <IStop />,
          disabled: busy,
          run: () => void actions.exclude(item),
        },
      ]
  const progress =
    readingAgy && ocrProgress && fileProgress(ocrProgress.done, ocrProgress.total)
      ? { kind: 'ocr' as const, ...fileProgress(ocrProgress.done, ocrProgress.total)! }
      : live?.kind === 'reading' && live.pages
        ? { kind: 'ocr' as const, ...live.pages }
        : live?.kind === 'embedding'
          ? { kind: 'chunks' as const, done: live.done, total: live.total }
          : (item.progress ??
            (detail && detail.chunkTotal > 0
              ? { kind: 'chunks' as const, done: detail.chunkDone, total: detail.chunkTotal }
              : undefined))
  return (
    <li
      className={`${isOpen ? 'is-selected' : ''}${finished ? ' is-done' : ''}${picked ? ' is-picked' : ''}${!item.offline && (readingAgy || working) ? ' is-processing' : ''}${item.offline || interrupted ? ' is-muted-source' : ''}`}
    >
      <div
        className="ixp-row"
        onContextMenu={onContextMenu}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            event.stopPropagation()
            showMenu(event.target as HTMLElement)
          }
        }}
      >
        {onPick && (
          <input
            className="ixp-pick"
            type="checkbox"
            checked={picked}
            aria-label={`${w.selectFile}: ${item.name}`}
            onChange={() => onPick(item, 'toggle')}
          />
        )}
        <button
          ref={mainRef}
          type="button"
          className="ixp-main"
          aria-expanded={isOpen}
          aria-controls={isOpen ? detailId : undefined}
          onClick={(event) => {
            if (onPick && (event.ctrlKey || event.metaKey || event.shiftKey)) {
              event.preventDefault()
              onPick(item, event.shiftKey ? 'range' : 'toggle')
              return
            }
            onPick?.(item, 'clear')
            actions.toggle(item)
          }}
        >
          <span
            className={`ixp-icon-wrap${working || readingAgy ? ' is-working' : ''}${finished ? ' is-ok' : ''}`}
          >
            <img className="ixp-file-icon" src={iconFor(item.name)} alt="" width="18" height="18" />
            {finished && (
              <svg className="ixp-check" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="8" fill="currentColor" />
                <path
                  d="m4.6 8.2 2.3 2.3 4.5-4.8"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span className="ixp-file-text">
            <span className="ixp-file-name" title={item.path}>
              {item.name}
            </span>
            {description && (
              <span
                className={`ixp-file-sub${working || readingAgy ? ' is-live' : ''}`}
                title={item.error ? `${item.error}\n${item.path}` : sub}
              >
                {description}
              </span>
            )}
          </span>
          <span className={`ixp-detail-chevron${isOpen ? ' is-open' : ''}`} aria-hidden="true">
            <IChevron />
          </span>
        </button>
        {busy ? (
          <span className="ixp-spin" role="status" aria-label={w.loading} />
        ) : (
          progress && <Progress progress={progress} />
        )}
        <span className="ixp-actions">
          <IconButton
            label={w.openFile}
            disabled={busy || !available.open}
            onClick={() => void actions.openFile(item)}
          >
            <IOpen />
          </IconButton>
          {working || readingAgy || ocrQueued ? (
            <IconButton label={w.stop} disabled={busy} onClick={() => void actions.stop(item)}>
              <IStop />
            </IconButton>
          ) : available.ocr ? (
            <IconButton
              label={w.readNow}
              disabled={busy || readingAgy}
              onClick={() => void actions.readNow(item)}
            >
              <ISpark />
            </IconButton>
          ) : retryable ? (
            <IconButton
              label={
                item.reason === 'waiting'
                  ? w.readFirst
                  : item.status === 'ready'
                    ? w.reread
                    : w.retry
              }
              disabled={busy}
              onClick={() => void actions.retry(item)}
            >
              <IRetry />
            </IconButton>
          ) : null}
          <IconButton
            label={w.reveal}
            disabled={busy || item.offline}
            onClick={() => void actions.reveal(item)}
          >
            <IFolder />
          </IconButton>
          <button
            type="button"
            className="ixp-icon ixp-more"
            title={w.moreActions}
            aria-label={`${w.moreActions}: ${item.name}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            aria-controls={menu ? menuId : undefined}
            onClick={(event) => (menu ? closeMenu() : showMenu(event.currentTarget))}
          >
            <Svg>
              <circle cx="3" cy="8" r="1" />
              <circle cx="8" cy="8" r="1" />
              <circle cx="13" cy="8" r="1" />
            </Svg>
          </button>
        </span>
      </div>
      {(readingAgy || working) && (
        <div
          className="ixp-processing-track"
          role="progressbar"
          aria-label={readingAgy ? ocrText : liveText}
        >
          <span />
        </div>
      )}
      {menu && (
        <FileMenu
          at={menu}
          entries={entries}
          onClose={closeMenu}
          id={menuId}
          label={item.name}
          trigger={menuTrigger.current}
        />
      )}
      {isOpen &&
        (detail === undefined ? (
          <p className="ixp-loading" id={detailId} role="status">
            {w.loading}
          </p>
        ) : detail === null ? (
          <div className="ixp-detail" id={detailId}>
            {actions.detailFailures.has(item.id) ? (
              <>
                <p>{w.detailFailed}</p>
                <button
                  type="button"
                  className="idx-link"
                  onClick={() => void actions.refreshDetail(item.id)}
                >
                  {w.refreshDetail}
                </button>
                <code className="ixp-raw">{item.error ?? item.path}</code>
              </>
            ) : (
              <code className="ixp-raw">{item.error ?? item.path}</code>
            )}
          </div>
        ) : (
          <div className="ixp-detail" id={detailId}>
            {actions.detailFailures.has(item.id) && <p className="idx-muted">{w.detailFailed}</p>}
            {readingAgy || working ? (
              <p className="idx-muted">{w.runningHint}</p>
            ) : (
              <ol className="ixp-steps">
                {deriveFileSteps(detail, lang)
                  .filter(
                    (step) =>
                      (step.key !== 'found' || step.state === 'fail') &&
                      step.key !== 'search' &&
                      !(step.key === 'read' && detail.status === 'empty' && detail.pdf),
                  )
                  .map((step) => (
                    <li key={step.key} className={`is-${step.state}`}>
                      <i aria-hidden="true" />
                      <span className="ixp-step-name">{lw[step.key]}</span>
                      <span className="ixp-step-text">
                        {step.key === 'read' && step.state === 'fail'
                          ? (issueHint ?? step.text)
                          : step.text}
                      </span>
                    </li>
                  ))}
              </ol>
            )}
            <details className="ixp-file-info">
              <summary>{w.fileInfo}</summary>
              <dl className="ixp-facts">
                <div>
                  <dt>{w.path}</dt>
                  <dd title={detail.path}>{detail.path}</dd>
                </div>
                {detail.sizeBytes !== undefined && (
                  <div>
                    <dt>{lw.size}</dt>
                    <dd>{formatBytes(detail.sizeBytes, dateLocale)}</dd>
                  </div>
                )}
                {detail.mtimeMs !== undefined && (
                  <div>
                    <dt>{lw.modified}</dt>
                    <dd>{new Date(detail.mtimeMs).toLocaleString(dateLocale)}</dd>
                  </div>
                )}
                <div>
                  <dt>{lw.updated}</dt>
                  <dd>{new Date(detail.updatedAt).toLocaleString(dateLocale)}</dd>
                </div>
              </dl>
              {detail.error && <code className="ixp-raw">{detail.error}</code>}
            </details>
          </div>
        ))}
    </li>
  )
}
