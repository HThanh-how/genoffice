import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { PdfPagesState } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'

const EN = {
  label: 'Pages read of each PDF',
  desc: 'Only the first pages of a PDF are read and searched: for a book that is its title and table of contents. Between 1 and {max}; {default} unless you change it. Scanned pages count too.',
  save: 'Save',
  saved: 'Saved.',
  rereading: 'Saved. {n} PDFs that were cut short are being read again.',
}
const VI: typeof EN = {
  label: 'Số trang đọc của mỗi PDF',
  desc: 'Chỉ những trang đầu của PDF được đọc và tìm kiếm: với sách là bìa và mục lục. Từ 1 đến {max}; mặc định {default}. Trang quét cũng tính trong số này.',
  save: 'Lưu',
  saved: 'Đã lưu.',
  rereading: 'Đã lưu. {n} PDF trước đó bị cắt ngắn đang được đọc lại.',
}

/** Settings → index: how many pages of each PDF are read and indexed (30 by default, 400 at most). */
export function PdfPagesSettings({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const w = lang === 'vi' ? VI : EN
  const [state, setState] = useState<PdfPagesState | null>(null)
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    let alive = true
    void api
      .getPdfPages()
      .then((next) => {
        if (!alive) return
        setState(next)
        setValue(String(next.pages))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api])
  if (!state) return null
  const save = () => {
    const pages = Number(value)
    if (!Number.isFinite(pages)) return
    void api
      .setPdfPages(pages)
      .then((next) => {
        setState(next)
        setValue(String(next.pages))
        setNote(next.requeued ? fill(w.rereading, { n: next.requeued }) : w.saved)
      })
      .catch(() => undefined)
  }
  return (
    <>
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
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <button type="button" className="idx-btn" onClick={save}>
        {w.save}
      </button>
      {note && (
        <p className="idx-muted" role="status">
          {note}
        </p>
      )}
    </>
  )
}
