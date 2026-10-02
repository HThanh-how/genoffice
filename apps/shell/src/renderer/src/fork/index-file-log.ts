import type { IndexFileDetail } from '../../../shared/fork/document-index-api'

/**
 * The processing story of one indexed file, worked out from what the index knows about it, and
 * the plain-text log made from it. Pure, so it is unit tested; the page only lays it out.
 */
export type StepState = 'ok' | 'warn' | 'fail' | 'run' | 'wait'

export interface FileStep {
  key: 'found' | 'read' | 'ocr' | 'embed' | 'search'
  state: StepState
  text: string
}

const STR = {
  vi: {
    found: 'Tìm thấy tệp',
    foundGone: 'Tệp không còn trên đĩa',
    read: 'Đọc chữ',
    ocr: 'OCR (đọc ảnh quét)',
    embed: 'Lập vector tìm kiếm',
    search: 'Tìm kiếm được',
    readOk: 'Đã đọc, tách thành {n} đoạn',
    readNoText: 'Không có chữ trong tệp (PDF quét hoặc ảnh)',
    readFail: 'Không đọc được: {e}',
    readWait: 'Đang chờ được đọc',
    readEmpty: 'Không có nội dung để đọc',
    ocrPages: '{done}/{total} trang đã đọc',
    ocrModel: 'bằng {m}',
    ocrChars: '{n} ký tự',
    ocrNone: 'Chưa OCR trang nào',
    embedProgress: '{done}/{total} đoạn',
    embedModel: 'mô hình {m}',
    searchYes: 'Có, đã tìm được trong chỉ mục',
    searchNo: 'Chưa, cần xử lý bước trên',
    size: 'Dung lượng',
    modified: 'Sửa lần cuối',
    updated: 'Chỉ mục cập nhật',
    path: 'Đường dẫn',
    status: 'Trạng thái',
    truncated: 'Chỉ đọc phần đầu của tệp dài',
    logTitle: 'Nhật ký xử lý tệp (GenOffice)',
  },
  en: {
    found: 'File found',
    foundGone: 'The file is no longer on disk',
    read: 'Read text',
    ocr: 'OCR (scanned images)',
    embed: 'Build search vectors',
    search: 'Searchable',
    readOk: 'Read and split into {n} passages',
    readNoText: 'No text in the file (scanned PDF or image)',
    readFail: 'Could not read: {e}',
    readWait: 'Waiting to be read',
    readEmpty: 'Nothing to read in it',
    ocrPages: '{done}/{total} pages read',
    ocrModel: 'with {m}',
    ocrChars: '{n} characters',
    ocrNone: 'No page read by OCR yet',
    embedProgress: '{done}/{total} passages',
    embedModel: 'model {m}',
    searchYes: 'Yes, it is in the search index',
    searchNo: 'Not yet; the step above needs to finish',
    size: 'Size',
    modified: 'Modified',
    updated: 'Index updated',
    path: 'Path',
    status: 'Status',
    truncated: 'Only the start of a long file was read',
    logTitle: 'File processing log (GenOffice)',
  },
}
export type LogWords = typeof STR.en

export function logWords(lang: string): LogWords {
  return (lang === 'vi' ? STR.vi : STR.en) as LogWords
}

const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))

export function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) return `${bytes}\u00a0B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: value < 10 ? 1 : 0 })}\u00a0${units[unit]}`
}

const stepName = (w: LogWords, key: FileStep['key']): string => w[key]

/** The file's journey, step by step. `reasonTitle` is the plain-language cause of its problem. */
export function deriveFileSteps(detail: IndexFileDetail, lang: string): FileStep[] {
  const w = logWords(lang)
  const steps: FileStep[] = []
  steps.push(
    detail.exists
      ? { key: 'found', state: 'ok', text: '' }
      : { key: 'found', state: 'fail', text: w.foundGone },
  )
  const ready = detail.status === 'ready'
  const scanned = !!detail.pdf && (detail.status === 'empty' || detail.pdf.ocrPages > 0)
  if (ready)
    steps.push({
      key: 'read',
      state: 'ok',
      text: fill(w.readOk, { n: detail.chunkTotal }),
    })
  else if (detail.status === 'error')
    steps.push({
      key: 'read',
      state: 'fail',
      text: fill(w.readFail, { e: detail.error ?? '' }),
    })
  else if (detail.status === 'empty')
    steps.push({
      key: 'read',
      state: 'warn',
      text: detail.pdf ? w.readNoText : w.readEmpty,
    })
  else steps.push({ key: 'read', state: 'wait', text: w.readWait })

  if (scanned && detail.pdf) {
    const total = detail.pdf.scannedPages || detail.pdf.totalPages
    const done = detail.pdf.ocrPages
    const bits = [
      done > 0 ? fill(w.ocrPages, { done, total }) : w.ocrNone,
      detail.pdf.ocrModel ? fill(w.ocrModel, { m: detail.pdf.ocrModel }) : '',
      detail.pdf.ocrChars > 0 ? fill(w.ocrChars, { n: detail.pdf.ocrChars }) : '',
    ].filter(Boolean)
    steps.push({
      key: 'ocr',
      state: done >= total && total > 0 ? 'ok' : done > 0 ? 'run' : 'wait',
      text: bits.join(' · '),
    })
  }

  if (detail.chunkTotal > 0)
    steps.push({
      key: 'embed',
      state: detail.chunkDone >= detail.chunkTotal ? 'ok' : 'run',
      text: [
        fill(w.embedProgress, { done: detail.chunkDone, total: detail.chunkTotal }),
        detail.embeddingModel ? fill(w.embedModel, { m: detail.embeddingModel }) : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })
  const searchable = ready && detail.chunkDone > 0
  steps.push({
    key: 'search',
    state: searchable ? 'ok' : 'wait',
    text: searchable ? w.searchYes : w.searchNo,
  })
  return steps
}

const MARK: Record<StepState, string> = {
  ok: '[ok]  ',
  warn: '[!]   ',
  fail: '[fail]',
  run: '[...] ',
  wait: '[ ]   ',
}

/** Plain text a person can paste into a message or a bug report. */
export function buildFileLog(
  detail: IndexFileDetail,
  lang: string,
  locale: string,
  reasonTitle?: string,
): string {
  const w = logWords(lang)
  const steps = deriveFileSteps(detail, lang)
  const when = (ms: number) => new Date(ms).toLocaleString(locale)
  const lines = [
    w.logTitle,
    `${w.path}: ${detail.path}`,
    `${w.status}: ${detail.status}${reasonTitle ? ` (${reasonTitle})` : ''}`,
    detail.sizeBytes === undefined ? '' : `${w.size}: ${formatBytes(detail.sizeBytes, locale)}`,
    detail.mtimeMs === undefined ? '' : `${w.modified}: ${when(detail.mtimeMs)}`,
    `${w.updated}: ${when(detail.updatedAt)}`,
    detail.truncated ? w.truncated : '',
    '',
    ...steps.map((step) => `${MARK[step.state]} ${step.text || stepName(w, step.key)}`),
    detail.error ? `\nerror: ${detail.error}` : '',
  ]
  return lines
    .filter((line, index) => line !== '' || lines[index - 1] !== '')
    .join('\n')
    .trim()
}
