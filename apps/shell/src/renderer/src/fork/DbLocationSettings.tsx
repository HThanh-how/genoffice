import { appConfirm } from '../ui-feedback'
import { useCallback, useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { DbLocationState, DbMoveError } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { formatBytes } from './index-file-log'
import { readIndexRequest } from './index-request'
import { IndexMutationTimeout, runIndexMutation } from './index-mutation'

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
  loading: 'Loading index location…',
  loadFailed: 'Could not load the index location.',
  retry: 'Try again',
  actionFailed: 'Could not complete this action. Try again.',
  unknownOutcome:
    'No confirmation arrived in time. The change may have completed; reload the status before trying again.',
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
  loading: 'Đang tải vị trí chỉ mục…',
  loadFailed: 'Không tải được vị trí chỉ mục.',
  retry: 'Thử lại',
  actionFailed: 'Không hoàn thành được thao tác. Hãy thử lại.',
  unknownOutcome:
    'Chưa nhận xác nhận kịp thời. Thay đổi có thể đã hoàn tất; hãy tải lại trạng thái trước khi thử tiếp.',
  errors: {
    invalid: 'Hãy chọn một thư mục trên máy này.',
    same: 'Chỉ mục đã nằm trong thư mục đó.',
    unwritable: 'GenOffice không ghi được vào thư mục đó.',
    space: 'Ổ đó không đủ chỗ trống (chỉ mục cần khoảng {size}).',
    exists: 'Thư mục đó đã có sẵn một file chỉ mục.',
  },
}

const isDbLocationState = (value: unknown): value is DbLocationState => {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<DbLocationState>
  return (
    typeof state.dir === 'string' &&
    typeof state.isDefault === 'boolean' &&
    Number.isFinite(state.sizeBytes) &&
    (state.pending === undefined || typeof state.pending === 'string') &&
    (state.lastError === undefined || typeof state.lastError === 'string')
  )
}

/** Where the index file lives, and moving it to another folder or drive (done at the next start). */
export function DbLocationSettings({ api }: { api: HomeApi }) {
  const { lang, dateLocale } = useI18n()
  const w = lang === 'vi' ? VI : EN
  const [state, setState] = useState<DbLocationState | null>(null)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const next = await readIndexRequest(() => api.getDbLocation(), isDbLocationState)
      setState(next)
      return next
    } catch {
      setLoadFailed(true)
      return null
    } finally {
      setLoading(false)
    }
  }, [api])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const planned = async (result: Awaited<ReturnType<HomeApi['chooseDbLocation']>>) => {
    if (result.ok) {
      const next = await refresh()
      if (!next) return
      setNote('')
      const message = fill(w.confirm, {
        size: formatBytes(result.sizeBytes, dateLocale),
        path: next.pending ?? '',
      })
      if (await appConfirm(message, { confirmLabel: w.restart })) await restart(true)
      return
    }
    if (result.canceled) return
    setNote(
      fill(w.errors[result.error ?? 'invalid'], {
        size: formatBytes(state?.sizeBytes ?? 0, dateLocale),
      }),
    )
  }

  const report = (error: unknown) =>
    setNote(error instanceof IndexMutationTimeout ? w.unknownOutcome : w.actionFailed)
  const restart = async (alreadyBusy = false) => {
    if (busy && !alreadyBusy) return
    if (!alreadyBusy) setBusy(true)
    setNote('')
    try {
      await runIndexMutation(() => api.restartForDbMove())
    } catch (error) {
      report(error)
    } finally {
      if (!alreadyBusy) setBusy(false)
    }
  }
  const choose = async (reset = false) => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      // Choosing a folder may take a while while the native picker is open.
      const result = await runIndexMutation(
        () => (reset ? api.resetDbLocation() : api.chooseDbLocation()),
        120_000,
      )
      await planned(result)
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      await runIndexMutation(() => api.cancelDbMove())
      await refresh()
    } catch (error) {
      report(error)
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
        <button type="button" className="idx-link" onClick={() => void refresh()}>
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
          <button type="button" className="idx-link" onClick={() => void refresh()}>
            {w.retry}
          </button>
        </p>
      )}
      <p className="idx-muted">
        {w.where}: <code>{state.dir}</code> ({formatBytes(state.sizeBytes, dateLocale)})
      </p>
      {state.pending ? (
        <>
          <p className="idx-muted" role="status">
            {fill(w.pending, { path: state.pending })}
          </p>
          <button type="button" className="idx-btn" disabled={busy} onClick={() => void restart()}>
            {w.restart}
          </button>{' '}
          <button type="button" className="idx-btn" disabled={busy} onClick={() => void cancel()}>
            {w.cancel}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="idx-btn" disabled={busy} onClick={() => void choose()}>
            {w.change}
          </button>
          {!state.isDefault && (
            <>
              {' '}
              <button
                type="button"
                className="idx-btn"
                disabled={busy}
                onClick={() => void choose(true)}
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
