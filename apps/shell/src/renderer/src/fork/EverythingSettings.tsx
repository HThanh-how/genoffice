import { useCallback, useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { EverythingState } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { readIndexRequest } from './index-request'
import { IndexMutationTimeout, runIndexMutation } from './index-mutation'

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
  loading: 'Loading Everything settings…',
  loadFailed: 'Could not load Everything settings.',
  retry: 'Try again',
  saveFailed: 'Could not save Everything settings. Try again.',
  unknownOutcome:
    'No confirmation arrived in time. The setting may have changed; reload before trying again.',
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
  loading: 'Đang tải cài đặt Everything…',
  loadFailed: 'Không tải được cài đặt Everything.',
  retry: 'Thử lại',
  saveFailed: 'Không lưu được cài đặt Everything. Hãy thử lại.',
  unknownOutcome:
    'Chưa nhận xác nhận kịp thời. Cài đặt có thể đã thay đổi; hãy tải lại trước khi thử tiếp.',
}

const everythingWords = (lang: string) => (lang === 'vi' ? VI : EN)

const isEverythingState = (value: unknown): value is EverythingState => {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<EverythingState>
  return (
    typeof state.supported === 'boolean' &&
    typeof state.enabled === 'boolean' &&
    typeof state.found === 'boolean' &&
    (state.path === undefined || typeof state.path === 'string')
  )
}

/** Settings → index: turn the optional Everything file-name search on or off (Windows only). */
export function EverythingSettings({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const w = everythingWords(lang)
  const [state, setState] = useState<EverythingState | null>(null)
  const [path, setPath] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const next = await readIndexRequest(() => api.getEverything(), isEverythingState)
      setState(next)
      setPath(next.path ?? '')
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])
  const save = async (change: { enabled: boolean; path?: string }) => {
    if (busy) return
    setBusy(true)
    setActionFailed(false)
    setNote('')
    try {
      const next = await runIndexMutation(() => api.setEverything(change))
      if (!isEverythingState(next)) throw new Error('Invalid Everything settings response')
      setState(next)
      setPath(next.path ?? '')
      setNote(w.saved)
    } catch (error) {
      setActionFailed(true)
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
  if (!state?.supported) return null
  return (
    <details className="idx-details">
      <summary>
        <strong>{w.title}</strong>
        <span>{w.hint}</span>
      </summary>
      <div>
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
              <div className="set-field-label">{w.switchLabel}</div>
              <div className="set-field-desc">{w.switchDesc}</div>
            </div>
          </div>
          <button
            className="set-switch"
            role="switch"
            aria-checked={state.enabled}
            aria-label={w.switchLabel}
            disabled={busy}
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
                disabled={busy}
                placeholder="C:\Program Files\Everything\es.exe"
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="idx-btn"
              disabled={busy}
              onClick={() => void save({ enabled: true, path })}
            >
              {w.save}
            </button>
          </>
        )}
        {(note || actionFailed) && (
          <p className="idx-muted" role="status">
            {note}
          </p>
        )}
      </div>
    </details>
  )
}
