import { useCallback, useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { DbLocationState, DbMoveError } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { formatBytes } from './index-file-log'

const EN = {
  where: 'Index location',
  change: 'Change location…',
  back: 'Back to the default folder',
  confirm:
    'Move the index ({size}) to this folder?\n\n{path}\n\nGenOffice restarts now and moves it while it starts. A large index can take a minute.',
  pending: 'The index moves to {path} when GenOffice restarts.',
  restart: 'Restart now',
  cancel: 'Cancel the move',
  lastError: 'The last move did not happen: {e}',
  errors: {
    invalid: 'Choose a folder on this computer.',
    same: 'The index is already in that folder.',
    unwritable: 'GenOffice cannot write to that folder.',
    space: 'There is not enough free space on that drive (the index needs about {size}).',
    exists: 'That folder already holds an index file.',
  } satisfies Record<DbMoveError, string>,
}
const VI: typeof EN = {
  where: 'Vị trí chỉ mục',
  change: 'Đổi vị trí…',
  back: 'Về thư mục mặc định',
  confirm:
    'Chuyển chỉ mục ({size}) sang thư mục này?\n\n{path}\n\nGenOffice sẽ khởi động lại và chuyển trong lúc mở. Chỉ mục lớn có thể mất khoảng một phút.',
  pending: 'Chỉ mục sẽ chuyển sang {path} khi GenOffice khởi động lại.',
  restart: 'Khởi động lại ngay',
  cancel: 'Huỷ việc chuyển',
  lastError: 'Lần chuyển trước không thành công: {e}',
  errors: {
    invalid: 'Hãy chọn một thư mục trên máy này.',
    same: 'Chỉ mục đã nằm trong thư mục đó.',
    unwritable: 'GenOffice không ghi được vào thư mục đó.',
    space: 'Ổ đó không đủ chỗ trống (chỉ mục cần khoảng {size}).',
    exists: 'Thư mục đó đã có sẵn một file chỉ mục.',
  },
}

/** Where the index file lives, and moving it to another folder or drive (done at the next start). */
export function DbLocationSettings({ api }: { api: HomeApi }) {
  const { lang, dateLocale } = useI18n()
  const w = lang === 'vi' ? VI : EN
  const [state, setState] = useState<DbLocationState | null>(null)
  const [note, setNote] = useState('')
  const refresh = useCallback(
    () =>
      api
        .getDbLocation()
        .then(setState)
        .catch(() => undefined),
    [api],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])

  const planned = async (result: Awaited<ReturnType<HomeApi['chooseDbLocation']>>) => {
    if (result.ok) {
      const next = await api.getDbLocation()
      setState(next)
      setNote('')
      const message = fill(w.confirm, {
        size: formatBytes(result.sizeBytes, dateLocale),
        path: next.pending ?? '',
      })
      if (window.confirm(message)) await api.restartForDbMove()
      return
    }
    if (result.canceled) return
    setNote(
      fill(w.errors[result.error ?? 'invalid'], {
        size: formatBytes(state?.sizeBytes ?? 0, dateLocale),
      }),
    )
  }

  if (!state) return null
  return (
    <>
      <p className="idx-muted">
        {w.where}: <code>{state.dir}</code> ({formatBytes(state.sizeBytes, dateLocale)})
      </p>
      {state.pending ? (
        <>
          <p className="idx-muted" role="status">
            {fill(w.pending, { path: state.pending })}
          </p>
          <button type="button" className="idx-btn" onClick={() => void api.restartForDbMove()}>
            {w.restart}
          </button>{' '}
          <button
            type="button"
            className="idx-btn"
            onClick={() => void api.cancelDbMove().then(refresh)}
          >
            {w.cancel}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="idx-btn"
            onClick={() => void api.chooseDbLocation().then(planned)}
          >
            {w.change}
          </button>
          {!state.isDefault && (
            <>
              {' '}
              <button
                type="button"
                className="idx-btn"
                onClick={() => void api.resetDbLocation().then(planned)}
              >
                {w.back}
              </button>
            </>
          )}
        </>
      )}
      {state.lastError && (
        <p className="idx-muted" role="status">
          {fill(w.lastError, { e: state.lastError })}
        </p>
      )}
      {note && (
        <p className="idx-muted" role="status">
          {note}
        </p>
      )}
    </>
  )
}
