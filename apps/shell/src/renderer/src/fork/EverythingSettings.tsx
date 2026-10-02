import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { EverythingState } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'

const EN = {
  title: 'Fast file names (Everything)',
  hint: 'Find any file by name at once, even one you never opened',
  switchLabel: 'Use Everything when it is installed',
  switchDesc:
    'Everything lists every file name on your drives and follows changes as they happen. GenOffice asks it for names, so files that were never opened still show up in the search box and in AI answers.',
  found: 'es.exe found. Keep Everything running in the background.',
  missing:
    'es.exe was not found. Install Everything and its command-line tool es.exe from voidtools.com, or enter where es.exe is.',
  path: 'Path to es.exe (optional)',
  save: 'Save',
  saved: 'Saved.',
}
const VI: typeof EN = {
  title: 'Tìm tên file nhanh (Everything)',
  hint: 'Tìm mọi file theo tên tức thì, kể cả file chưa từng mở',
  switchLabel: 'Dùng Everything nếu đã cài',
  switchDesc:
    'Everything liệt kê tên mọi file trên các ổ và cập nhật ngay khi có thay đổi. GenOffice hỏi nó về tên file, nên file chưa từng mở vẫn hiện trong ô tìm kiếm và câu trả lời của AI.',
  found: 'Đã thấy es.exe. Hãy để Everything chạy nền.',
  missing:
    'Chưa thấy es.exe. Cài Everything và công cụ dòng lệnh es.exe từ voidtools.com, hoặc nhập vị trí của es.exe.',
  path: 'Đường dẫn es.exe (không bắt buộc)',
  save: 'Lưu',
  saved: 'Đã lưu.',
}

const everythingWords = (lang: string) => (lang === 'vi' ? VI : EN)

/** Settings → index: turn the optional Everything file-name search on or off (Windows only). */
export function EverythingSettings({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const w = everythingWords(lang)
  const [state, setState] = useState<EverythingState | null>(null)
  const [path, setPath] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    let alive = true
    void api
      .getEverything()
      .then((next) => {
        if (!alive) return
        setState(next)
        setPath(next.path ?? '')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api])
  if (!state?.supported) return null
  const save = (change: { enabled: boolean; path?: string }) =>
    api
      .setEverything(change)
      .then((next) => {
        setState(next)
        setNote(w.saved)
      })
      .catch(() => undefined)
  return (
    <details className="idx-details">
      <summary>
        <strong>{w.title}</strong>
        <span>{w.hint}</span>
      </summary>
      <div>
        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-stack">
              <div className="set-field-label">{w.switchLabel}</div>
              <div className="set-field-desc">{w.switchDesc}</div>
            </div>
          </div>
          <button
            className="set-switch"
            role="switch"
            aria-checked={state.enabled}
            aria-label={w.switchLabel}
            onClick={() => void save({ enabled: !state.enabled, path: state.path })}
          />
        </div>
        {state.enabled && (
          <>
            <p className="idx-muted" role="status">
              {state.found ? w.found : w.missing}
            </p>
            <label className="idx-muted">
              {w.path}
              <input
                type="text"
                className="idx-input"
                value={path}
                placeholder="C:\Program Files\Everything\es.exe"
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="idx-btn"
              onClick={() => void save({ enabled: true, path })}
            >
              {w.save}
            </button>
          </>
        )}
        {note && (
          <p className="idx-muted" role="status">
            {note}
          </p>
        )}
      </div>
    </details>
  )
}
