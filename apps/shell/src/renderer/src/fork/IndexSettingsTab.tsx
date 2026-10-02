import { useState, type ReactNode } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { IndexingModeSettings } from './IndexingModeSettings'
import { AgyOcrSettings } from './AgyOcrSettings'
import { EmbeddingModelSettings } from './EmbeddingModelSettings'
import { EverythingSettings } from './EverythingSettings'
import { DbLocationSettings } from './DbLocationSettings'

const EN = {
  run: 'Running in the background',
  runHint: 'How hard it works, and when it rests',
  ocr: 'Reading scanned PDFs',
  ocrHint: 'Daily limit, pages, model, quota floors',
  model: 'Search model',
  modelHint: 'Standard or high quality',
  data: 'Data',
  dataHint: 'Where the index is kept, and clearing it',
  clear: 'Delete the whole index…',
  confirm: 'Delete the whole index? The index data on this computer will be removed.',
  cleared: 'The index was deleted.',
}
const VI: typeof EN = {
  run: 'Chạy nền',
  runHint: 'Làm việc mạnh nhẹ ra sao, khi nào nghỉ',
  ocr: 'Đọc PDF quét (OCR)',
  ocrHint: 'Số PDF mỗi ngày, số trang, mô hình, ngưỡng quota',
  model: 'Mô hình tìm kiếm',
  modelHint: 'Chuẩn hay chất lượng cao',
  data: 'Dữ liệu',
  dataHint: 'Chỉ mục nằm ở đâu, và xoá nó',
  clear: 'Xoá toàn bộ chỉ mục…',
  confirm: 'Xóa toàn bộ chỉ mục? Dữ liệu chỉ mục trên máy sẽ bị xóa.',
  cleared: 'Đã xoá chỉ mục.',
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <details className="idx-details">
      <summary>
        <strong>{title}</strong>
        <span>{hint}</span>
      </summary>
      <div>{children}</div>
    </details>
  )
}

/** The index settings in four folded sections, each with a one-line hint of what is inside. */
export function IndexSettingsTab({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const [note, setNote] = useState('')
  return (
    <div className="ixp">
      <Section title={d.run} hint={d.runHint}>
        <IndexingModeSettings />
      </Section>
      <Section title={d.ocr} hint={d.ocrHint}>
        <AgyOcrSettings />
      </Section>
      <Section title={d.model} hint={d.modelHint}>
        <EmbeddingModelSettings />
      </Section>
      <EverythingSettings api={api} />
      <Section title={d.data} hint={d.dataHint}>
        <DbLocationSettings api={api} />
        <button
          type="button"
          className="idx-btn"
          onClick={() => {
            if (!window.confirm(d.confirm)) return
            void api.clearDocumentMemory().then(() => setNote(d.cleared))
          }}
        >
          {d.clear}
        </button>
        {note && (
          <p className="idx-muted" role="status">
            {note}
          </p>
        )}
      </Section>
    </div>
  )
}
