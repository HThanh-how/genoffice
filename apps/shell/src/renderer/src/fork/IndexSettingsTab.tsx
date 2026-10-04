import { appConfirm } from '../ui-feedback'
import { useRef, useState, type ReactNode } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { IndexingModeSettings } from './IndexingModeSettings'
import { AgyOcrSettings } from './AgyOcrSettings'
import { EmbeddingModelSettings } from './EmbeddingModelSettings'
import { EverythingSettings } from './EverythingSettings'
import { DbLocationSettings } from './DbLocationSettings'
import { PdfPagesSettings } from './PdfPagesSettings'
import './index-settings.css'

const EN = {
  title: 'Index settings',
  hint: 'Choose how your files are read and kept ready for search.',
  advanced: 'Advanced reading & search',
  advancedHint: 'Fine-tune scanned documents and search quality when needed.',
  storage: 'Index storage',
  storageHint: 'Choose where the local search database is kept.',
  clearTitle: 'Clear indexed content',
  clearHint:
    'Removes extracted text and search data. Your original files stay in place; excluded files remain excluded.',
  clearing: 'Clearing…',
  failed: 'The index could not be cleared. Please try again.',
  run: 'Running in the background',
  runHint: 'How hard it works, and when it rests',
  pdf: 'PDF pages',
  pdfHint: 'How many pages of each PDF are read',
  ocr: 'Reading scanned PDFs',
  ocrHint: 'Daily limit, pages, model, quota floors',
  model: 'Search model',
  modelHint: 'Standard or high quality',
  data: 'Data',
  dataHint: 'Where the index is kept, and clearing it',
  clear: 'Clear indexed content…',
  confirm:
    'Clear indexed content on this computer? Extracted text and search data will be removed. Original files and exclusions are kept.',
  cleared: 'Indexed content was cleared.',
}
const VI: typeof EN = {
  title: 'Cài đặt chỉ mục',
  hint: 'Chọn cách đọc tệp và chuẩn bị dữ liệu để tìm kiếm.',
  advanced: 'Đọc & tìm kiếm nâng cao',
  advancedHint: 'Tinh chỉnh tài liệu quét và chất lượng tìm kiếm khi cần.',
  storage: 'Nơi lưu chỉ mục',
  storageHint: 'Chọn nơi lưu cơ sở dữ liệu tìm kiếm trên máy.',
  clearTitle: 'Xoá nội dung đã lập chỉ mục',
  clearHint:
    'Xoá văn bản đã trích xuất và dữ liệu tìm kiếm. Tệp gốc được giữ nguyên; tệp đã loại trừ vẫn được loại trừ.',
  clearing: 'Đang xoá…',
  failed: 'Không thể xoá chỉ mục. Vui lòng thử lại.',
  run: 'Chạy nền',
  runHint: 'Làm việc mạnh nhẹ ra sao, khi nào nghỉ',
  pdf: 'Số trang PDF',
  pdfHint: 'Đọc bao nhiêu trang đầu của mỗi PDF',
  ocr: 'Đọc PDF quét (OCR)',
  ocrHint: 'Số PDF mỗi ngày, số trang, mô hình, ngưỡng quota',
  model: 'Mô hình tìm kiếm',
  modelHint: 'Chuẩn hay chất lượng cao',
  data: 'Dữ liệu',
  dataHint: 'Chỉ mục nằm ở đâu, và xoá nó',
  clear: 'Xoá nội dung chỉ mục…',
  confirm:
    'Xoá nội dung đã lập chỉ mục trên máy? Văn bản trích xuất và dữ liệu tìm kiếm sẽ bị xoá. Tệp gốc và danh sách loại trừ được giữ nguyên.',
  cleared: 'Đã xoá nội dung chỉ mục.',
}

type SectionIcon = 'run' | 'pdf' | 'ocr' | 'model' | 'data'
const ICON_PATHS: Record<SectionIcon, string> = {
  run: 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  pdf: 'M7 3h7l4 4v14H7zM14 3v5h4M10 12h5m-5 4h5',
  ocr: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 9h8m-4 0v7m-3 0h6',
  model: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm5.5-2 5 5',
  data: 'M4 6c0-4 16-4 16 0s-16 4-16 0Zm0 0v6c0 4 16 4 16 0V6M4 12v6c0 4 16 4 16 0v-6',
}
function Section({
  title,
  hint,
  icon,
  open = false,
  children,
}: {
  title: string
  hint: string
  icon: SectionIcon
  open?: boolean
  children: ReactNode
}) {
  return (
    <details className="idx-details" open={open}>
      <summary>
        <svg className="ixs-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d={ICON_PATHS[icon]}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="ixs-section-text">
          <strong>{title}</strong>
          <span>{hint}</span>
        </span>
      </summary>
      <div>{children}</div>
    </details>
  )
}

export function IndexSettingsTab({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const [note, setNote] = useState('')
  const [failed, setFailed] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearPending = useRef(false)
  const clear = async () => {
    if (clearPending.current) return
    clearPending.current = true
    setClearing(true)
    try {
      if (
        !(await appConfirm(d.confirm, {
          title: d.clearTitle,
          confirmLabel: d.clear,
          tone: 'danger',
        }))
      )
        return
      setNote('')
      setFailed(false)
      await api.clearDocumentMemory()
      setNote(d.cleared)
    } catch {
      setFailed(true)
      setNote(d.failed)
    } finally {
      clearPending.current = false
      setClearing(false)
    }
  }
  return (
    <div className="ixp ixs">
      <header className="ixs-head">
        <h2>{d.title}</h2>
        <p>{d.hint}</p>
      </header>
      <Section title={d.run} hint={d.runHint} icon="run" open>
        <IndexingModeSettings />
      </Section>
      <Section title={d.pdf} hint={d.pdfHint} icon="pdf" open>
        <PdfPagesSettings api={api} />
      </Section>
      <div className="ixs-heading">
        <h3>{d.advanced}</h3>
        <p>{d.advancedHint}</p>
      </div>
      <Section title={d.ocr} hint={d.ocrHint} icon="ocr">
        <AgyOcrSettings />
      </Section>
      <Section title={d.model} hint={d.modelHint} icon="model">
        <EmbeddingModelSettings />
      </Section>
      <EverythingSettings api={api} />
      <Section title={d.storage} hint={d.storageHint} icon="data" open>
        <DbLocationSettings api={api} />
      </Section>
      <section className="ixs-danger" aria-label={d.clearTitle}>
        <div>
          <h3>{d.clearTitle}</h3>
          <p>{d.clearHint}</p>
        </div>
        <button
          type="button"
          className="idx-btn ixs-clear"
          disabled={clearing}
          onClick={() => void clear()}
        >
          {clearing ? d.clearing : d.clear}
        </button>
        {note && (
          <p className={failed ? 'ixs-error' : 'idx-muted'} role={failed ? 'alert' : 'status'}>
            {note}
          </p>
        )}
      </section>
    </div>
  )
}
