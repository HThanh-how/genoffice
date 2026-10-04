import { useCallback, useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { PdfPagesState } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { readIndexRequest } from './index-request'
import { IndexMutationTimeout, runIndexMutation } from './index-mutation'

const EN = {
  label: 'Pages read of each PDF',
  desc: 'Only the first pages of a PDF are read and searched: for a book that is its title and table of contents. Between 1 and {max}; {default} unless you change it. Scanned pages count too.',
  save: 'Save',
  saved: 'Saved.',
  rereading: 'Saved. {n} PDFs that were cut short are being read again.',
  loading: 'Loading PDF page settings…',
  loadFailed: 'Could not load PDF page settings.',
  retry: 'Try again',
  saveFailed: 'Could not save this setting. Try again.',
  unknownOutcome:
    'No confirmation arrived in time. The setting may have been saved; reload before trying again.',
  invalid: 'Enter a whole number from 1 to {max}.',
}
const VI: typeof EN = {
  label: 'Số trang đọc của mỗi PDF',
  desc: 'Chỉ những trang đầu của PDF được đọc và tìm kiếm: với sách là bìa và mục lục. Từ 1 đến {max}; mặc định {default}. Trang quét cũng tính trong số này.',
  save: 'Lưu',
  saved: 'Đã lưu.',
  rereading: 'Đã lưu. {n} PDF trước đó bị cắt ngắn đang được đọc lại.',
  loading: 'Đang tải cài đặt số trang PDF…',
  loadFailed: 'Không tải được cài đặt số trang PDF.',
  retry: 'Thử lại',
  saveFailed: 'Không lưu được cài đặt. Hãy thử lại.',
  unknownOutcome:
    'Chưa nhận xác nhận kịp thời. Cài đặt có thể đã được lưu; hãy tải lại trước khi thử tiếp.',
  invalid: 'Nhập số nguyên từ 1 đến {max}.',
}

const isPdfPagesState = (value: unknown): value is PdfPagesState => {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<PdfPagesState>
  return (
    Number.isSafeInteger(state.pages) &&
    Number.isSafeInteger(state.default) &&
    Number.isSafeInteger(state.max) &&
    (state.pages as number) >= 1 &&
    (state.max as number) >= (state.pages as number)
  )
}

/** Settings → index: how many pages of each PDF are read and indexed (30 by default, 400 at most). */
export function PdfPagesSettings({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const w = lang === 'vi' ? VI : EN
  const [state, setState] = useState<PdfPagesState | null>(null)
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const next = await readIndexRequest(() => api.getPdfPages(), isPdfPagesState)
      setState(next)
      setValue(String(next.pages))
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (!state || busy) return
    const pages = Number(value)
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > state.max) {
      setNote(fill(w.invalid, { max: state.max }))
      return
    }
    setBusy(true)
    setNote('')
    try {
      const next = await runIndexMutation(() => api.setPdfPages(pages))
      if (!isPdfPagesState(next) || !Number.isSafeInteger(next.requeued))
        throw new Error('Invalid PDF page setting response')
      setState(next)
      setValue(String(next.pages))
      setNote(next.requeued ? fill(w.rereading, { n: next.requeued }) : w.saved)
    } catch (error) {
      setNote(error instanceof IndexMutationTimeout ? w.unknownOutcome : w.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  if (loading && !state)
    return (
      <p className="idx-muted" role="status">
        {w.loading}
      </p>
    )
  if (loadFailed && !state)
    return (
      <p className="idx-muted" role="status">
        {w.loadFailed}{' '}
        <button type="button" className="idx-link" onClick={() => void load()}>
          {w.retry}
        </button>
      </p>
    )
  if (!state) return null
  return (
    <>
      {loadFailed && (
        <p className="idx-muted" role="status">
          {w.loadFailed}{' '}
          <button type="button" className="idx-link" onClick={() => void load()}>
            {w.retry}
          </button>
        </p>
      )}
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{w.label}</div>
            <div className="set-field-desc">
              {fill(w.desc, { max: state.max, default: state.default })}
            </div>
          </div>
        </div>
        <input
          type="number"
          className="idx-input"
          aria-label={w.label}
          min={1}
          max={state.max}
          value={value}
          disabled={busy || loading}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <button
        type="button"
        className="idx-btn"
        disabled={busy || loading}
        onClick={() => void save()}
      >
        {busy ? (lang === 'vi' ? 'Đang lưu…' : 'Saving…') : w.save}
      </button>
      {note && (
        <p className="idx-muted" role="status">
          {note}
        </p>
      )}
    </>
  )
}
