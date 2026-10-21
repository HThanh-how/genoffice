import { appConfirm } from '../ui-feedback'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { IndexingModeSettings } from './IndexingModeSettings'
import { AgyOcrSettings } from './AgyOcrSettings'
import { EmbeddingModelSettings } from './EmbeddingModelSettings'
import { EverythingSettings } from './EverythingSettings'
import { DbLocationSettings } from './DbLocationSettings'
import { IndexStorageSettings } from './IndexStorageSettings'
import { PdfPagesSettings } from './PdfPagesSettings'
import { IndexDiagnostics } from './IndexDiagnostics'
import './index-settings.css'
import { IndexMutationTimeout, runIndexMutation } from './index-mutation'
import { IndexingRulesStudio } from './IndexingRulesStudio'

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
  unknown:
    'The clear request has not acknowledged completion. Check the index before trying again.',
  run: 'Running in the background',
  runHint: 'How hard it works, and when it rests',
  pdf: 'PDF pages',
  pdfHint: 'How many pages of each PDF are read',
  ocr: 'Reading scanned PDFs',
  ocrHint: 'Daily limit, pages, model, quota floors',
  model: 'Search model',
  modelHint: 'Standard or high quality',
  diagnostics: 'Diagnostics',
  diagnosticsHint: 'Model architecture, vector dimensions, ANN state, and cache',
  data: 'Data',
  dataHint: 'Where the index is kept, and clearing it',
  clear: 'Clear indexed content…',
  confirm:
    'Clear indexed content on this computer? Extracted text and search data will be removed. Original files and exclusions are kept.',
  cleared: 'Indexed content was cleared.',
  ignore: 'Ignore rules',
  ignoreHint: 'Exclude files and folders by pattern or folder scope from indexing.',
  ignoreAddRule: 'Add rule',
  ignorePatternPlaceholder: 'Pattern (e.g. *.tmp, private/, ~$*)',
  ignoreDescPlaceholder: 'Description (optional)',
  ignoreScopeAll: 'All folders (Global)',
  ignoreScope: 'Scope',
  ignoreEmpty: 'No ignore rules configured.',
  ignoreTestTitle: 'Test a path',
  ignoreTestPlaceholder: 'Enter a file or folder path to test (e.g. C:\\Docs\\file.tmp)',
  ignoreTestBtn: 'Check path',
  ignoreStatusIgnored: 'Ignored (excluded from indexing and search)',
  ignoreStatusIndexed: 'Indexed (available in search)',
  ignoreStatusNotIndexed: 'Not yet indexed (allowed by ignore rules)',
  ignoreSaved: 'Ignore rules saved.',
  ignoreDelete: 'Remove',
  ignoreEdit: 'Edit',
  ignoreSave: 'Save',
  ignoreCancel: 'Cancel',
  ignoreFromGenoffice: '.genofficeignore',
  ignoreUserRule: 'Custom',
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
  unknown: 'Chưa nhận được xác nhận xoá xong. Hãy kiểm tra chỉ mục trước khi thực hiện lại.',
  run: 'Chạy nền',
  runHint: 'Làm việc mạnh nhẹ ra sao, khi nào nghỉ',
  pdf: 'Số trang PDF',
  pdfHint: 'Đọc bao nhiêu trang đầu của mỗi PDF',
  ocr: 'Đọc PDF quét (OCR)',
  ocrHint: 'Số PDF mỗi ngày, số trang, mô hình, ngưỡng quota',
  model: 'Mô hình tìm kiếm',
  modelHint: 'Chuẩn hay chất lượng cao',
  diagnostics: 'Chẩn đoán',
  diagnosticsHint: 'Kiến trúc mô hình, số chiều vector, trạng thái ANN và bộ nhớ đệm',
  data: 'Dữ liệu',
  dataHint: 'Chỉ mục nằm ở đâu, và xoá nó',
  clear: 'Xoá nội dung chỉ mục…',
  confirm:
    'Xoá nội dung đã lập chỉ mục trên máy? Văn bản trích xuất và dữ liệu tìm kiếm sẽ bị xoá. Tệp gốc và danh sách loại trừ được giữ nguyên.',
  cleared: 'Đã xoá nội dung chỉ mục.',
  ignore: 'Quy tắc loại trừ',
  ignoreHint: 'Loại trừ tệp và thư mục theo mẫu hoặc phạm vi thư mục khỏi chỉ mục.',
  ignoreAddRule: 'Thêm quy tắc',
  ignorePatternPlaceholder: 'Mẫu (vd: *.tmp, private/, ~$*)',
  ignoreDescPlaceholder: 'Mô tả (tuỳ chọn)',
  ignoreScopeAll: 'Tất cả thư mục (Toàn cục)',
  ignoreScope: 'Phạm vi',
  ignoreEmpty: 'Chưa có quy tắc loại trừ nào.',
  ignoreTestTitle: 'Kiểm tra đường dẫn',
  ignoreTestPlaceholder: 'Nhập đường dẫn tệp hoặc thư mục để thử (vd: C:\\Docs\\file.tmp)',
  ignoreTestBtn: 'Kiểm tra',
  ignoreStatusIgnored: 'Đã loại trừ (bị bỏ qua khi quét và tìm kiếm)',
  ignoreStatusIndexed: 'Đã lập chỉ mục (tìm kiếm được)',
  ignoreStatusNotIndexed: 'Chưa lập chỉ mục (hợp lệ theo quy tắc loại trừ)',
  ignoreSaved: 'Đã lưu quy tắc loại trừ.',
  ignoreDelete: 'Xoá',
  ignoreEdit: 'Sửa',
  ignoreSave: 'Lưu',
  ignoreCancel: 'Huỷ',
  ignoreFromGenoffice: '.genofficeignore',
  ignoreUserRule: 'Tuỳ chỉnh',
}

/** One settings row: title and a one-line description, expanding in place. No icon tiles. */
function Section({
  title,
  hint,
  open = false,
  children,
  id,
}: {
  title: string
  hint: string
  open?: boolean
  children: ReactNode
  id?: string
}) {
  return (
    <details id={id} className="idx-details ixs-row" open={open}>
      <summary>
        <span className="ixs-section-text">
          <strong>{title}</strong>
          <span>{hint}</span>
        </span>
      </summary>
      <div className="ixs-row-body">{children}</div>
    </details>
  )
}

export function IgnoreRulesSettings({ api }: { api: HomeApi }) {
  return <IndexingRulesStudio api={api} />
}

export function IndexSettingsTab({ api, focus }: { api: HomeApi; focus?: 'ocr' }) {
  const { lang } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const [note, setNote] = useState('')
  const [failed, setFailed] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearPending = useRef(false)
  useEffect(() => {
    if (focus === 'ocr')
      document.getElementById('index-settings-ocr')?.scrollIntoView({ block: 'nearest' })
  }, [focus])
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
      await runIndexMutation(() => api.clearDocumentMemory())
      setNote(d.cleared)
    } catch (error) {
      setFailed(true)
      setNote(error instanceof IndexMutationTimeout ? d.unknown : d.failed)
    } finally {
      clearPending.current = false
      setClearing(false)
    }
  }
  return (
    <div className="ixs">
      <div className="ixs-list">
        <Section title={d.run} hint={d.runHint}>
          <IndexingModeSettings />
        </Section>
        <Section title={d.pdf} hint={d.pdfHint}>
          <PdfPagesSettings api={api} />
        </Section>
        <Section title={d.ignore} hint={d.ignoreHint}>
          <IgnoreRulesSettings api={api} />
        </Section>
      </div>
      <details className="ixs-group" open={focus === 'ocr'}>
        <summary>
          <span className="ixs-section-text">
            <strong>{d.advanced}</strong>
            <span>{d.advancedHint}</span>
          </span>
        </summary>
        <div className="ixs-list">
          <Section id="index-settings-ocr" title={d.ocr} hint={d.ocrHint} open={focus === 'ocr'}>
            <AgyOcrSettings />
          </Section>
          <Section title={d.model} hint={d.modelHint}>
            <EmbeddingModelSettings />
          </Section>
          <Section title={d.diagnostics} hint={d.diagnosticsHint}>
            <IndexDiagnostics api={api} />
          </Section>
          <EverythingSettings api={api} />
          <Section title={d.storage} hint={d.storageHint}>
            <DbLocationSettings api={api} />
            <IndexStorageSettings api={api} />
          </Section>
        </div>
      </details>
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
