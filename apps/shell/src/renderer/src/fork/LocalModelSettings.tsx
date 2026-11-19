import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LocalModelApi,
  LocalModelSelectOutcome,
  LocalModelState,
} from '../../../shared/fork/local-model-api'
import { useI18n } from '../locale'
import { appConfirm } from '../ui-feedback'
import { SettingsCard, SettingsRow } from './settings-ui/SettingsCard'
import './local-model.css'

const EN = {
  title: 'Local AI model',
  desc: 'Runs on this computer with llama.cpp. Your prompts and documents are not sent to the cloud.',
  model: 'Model',
  status: 'Status',
  notInstalled: 'Not installed',
  downloading: 'Downloading',
  ready: 'Ready',
  error: 'Error',
  partial: '{done} already downloaded',
  progress: '{done} of {total} ({pct}%)',
  sourceDownloaded: 'Downloaded by GenOffice',
  sourceSelected: 'Your file: {path}',
  download: 'Download',
  resume: 'Resume download',
  retry: 'Retry',
  select: 'Select existing file…',
  cancel: 'Cancel download',
  redownload: 'Re-download',
  delete: 'Delete model',
  verifying: 'Verifying the file…',
  working: 'Working…',
  loading: 'Reading the model status…',
  unavailable: 'The local model status is not available. Restart GenOffice and try again.',
  confirmCancel: 'Cancel the download?\n\nThe part downloaded so far is deleted.',
  confirmDelete:
    'Delete the downloaded model?\n\nThe local provider cannot answer until it is downloaded again ({size}).',
  confirmForget:
    'Stop using this model file?\n\nYour file stays where it is; GenOffice only forgets it.',
  confirmRedownload:
    'Download the model again?\n\nThe current copy is removed first, then about {size} is downloaded.',
  deleteFailed: 'The model could not be deleted, so no new download was started.',
  actionFailed: 'That did not work. Please try again.',
}

const VI: typeof EN = {
  title: 'Model AI cục bộ',
  desc: 'Chạy ngay trên máy này bằng llama.cpp. Câu hỏi và tài liệu của bạn không được gửi lên cloud.',
  model: 'Model',
  status: 'Trạng thái',
  notInstalled: 'Chưa cài đặt',
  downloading: 'Đang tải',
  ready: 'Sẵn sàng',
  error: 'Lỗi',
  partial: 'Đã tải được {done}',
  progress: '{done} / {total} ({pct}%)',
  sourceDownloaded: 'Do GenOffice tải về',
  sourceSelected: 'Tệp của bạn: {path}',
  download: 'Tải về',
  resume: 'Tải tiếp',
  retry: 'Thử lại',
  select: 'Chọn tệp có sẵn…',
  cancel: 'Hủy tải',
  redownload: 'Tải lại',
  delete: 'Xóa model',
  verifying: 'Đang kiểm tra tệp…',
  working: 'Đang xử lý…',
  loading: 'Đang đọc trạng thái model…',
  unavailable: 'Không đọc được trạng thái model cục bộ. Hãy khởi động lại GenOffice và thử lại.',
  confirmCancel: 'Hủy tải về?\n\nPhần đã tải sẽ bị xóa.',
  confirmDelete:
    'Xóa model đã tải?\n\nProvider cục bộ sẽ không trả lời được cho tới khi tải lại ({size}).',
  confirmForget:
    'Ngừng dùng tệp model này?\n\nTệp của bạn vẫn ở nguyên chỗ cũ; GenOffice chỉ bỏ ghi nhớ nó.',
  confirmRedownload:
    'Tải lại model?\n\nBản hiện tại sẽ bị gỡ trước, sau đó tải khoảng {size}.',
  deleteFailed: 'Không xóa được model nên chưa bắt đầu tải lại.',
  actionFailed: 'Thao tác không thành công. Hãy thử lại.',
}

const ZH: typeof EN = {
  title: '本地 AI 模型',
  desc: '使用 llama.cpp 在本机运行。你的提问和文档不会发送到云端。',
  model: '模型',
  status: '状态',
  notInstalled: '未安装',
  downloading: '正在下载',
  ready: '就绪',
  error: '错误',
  partial: '已下载 {done}',
  progress: '{done} / {total}（{pct}%）',
  sourceDownloaded: '由 GenOffice 下载',
  sourceSelected: '你的文件：{path}',
  download: '下载',
  resume: '继续下载',
  retry: '重试',
  select: '选择已有文件…',
  cancel: '取消下载',
  redownload: '重新下载',
  delete: '删除模型',
  verifying: '正在校验文件…',
  working: '正在处理…',
  loading: '正在读取模型状态…',
  unavailable: '无法读取本地模型状态。请重启 GenOffice 后再试。',
  confirmCancel: '取消下载？\n\n已下载的部分将被删除。',
  confirmDelete: '删除已下载的模型？\n\n在重新下载（{size}）之前，本地服务商无法回答。',
  confirmForget: '不再使用这个模型文件？\n\n你的文件保留在原处，GenOffice 只是不再记住它。',
  confirmRedownload: '重新下载模型？\n\n会先移除当前副本，然后下载约 {size}。',
  deleteFailed: '模型未能删除，因此没有开始新的下载。',
  actionFailed: '操作未成功，请重试。',
}

const DICTS: Record<string, typeof EN> = { en: EN, vi: VI, zh: ZH }

/** The model this card manages (the manager pins exactly one). */
const MODEL_NAME = 'LFM3-VL-2B-Q4_K_M'

/** Poll cadence: fast while bytes are moving or an action runs, slow otherwise (another window may change it). */
export const LOCAL_MODEL_FAST_POLL_MS = 1000
export const LOCAL_MODEL_SLOW_POLL_MS = 5000

type Busy = 'working' | 'verifying' | null

function api(): LocalModelApi | undefined {
  const office = (window as unknown as { aiOffice?: Partial<LocalModelApi> }).aiOffice
  return typeof office?.getLocalModelState === 'function' ? (office as LocalModelApi) : undefined
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  )
}

export function formatModelBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`
}

/** Settings → AI Model, provider "Local": download, choose, cancel and delete the on-device model. */
export function LocalModelSettings() {
  const { lang } = useI18n()
  const d = DICTS[lang] ?? EN
  const [state, setState] = useState<LocalModelState | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusyState] = useState<Busy>(null)
  const [note, setNote] = useState('')
  const mountedRef = useRef(true)
  // the guard reads a ref: two quick clicks must not both start an action
  const busyRef = useRef<Busy>(null)
  const setBusy = (next: Busy) => {
    busyRef.current = next
    setBusyState(next)
  }

  const refresh = useCallback(async () => {
    const local = api()
    if (!local) {
      if (mountedRef.current) setFailed(true)
      return
    }
    try {
      const next = await local.getLocalModelState()
      if (mountedRef.current) {
        setState(next)
        setFailed(false)
      }
    } catch {
      // a missed poll keeps the last state on screen; `failed` is shown only before a first state
      if (mountedRef.current) setFailed(true)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  // same polling pattern as DocumentMemorySettings: an interval while the card is mounted
  const fast = state?.status === 'downloading' || busy !== null
  useEffect(() => {
    const timer = window.setInterval(
      () => void refresh(),
      fast ? LOCAL_MODEL_FAST_POLL_MS : LOCAL_MODEL_SLOW_POLL_MS,
    )
    return () => window.clearInterval(timer)
  }, [fast, refresh])

  /** Runs one action at a time; the card re-reads the state afterwards in every case. */
  const run = async (kind: Exclude<Busy, null>, action: (local: LocalModelApi) => Promise<void>) => {
    const local = api()
    if (!local || busyRef.current) return
    setBusy(kind)
    setNote('')
    try {
      await action(local)
    } catch {
      if (mountedRef.current) setNote(d.actionFailed)
    } finally {
      if (mountedRef.current) setBusy(null)
      await refresh()
    }
  }

  const apply = (next: LocalModelState) => {
    if (mountedRef.current) setState(next)
  }

  const download = () => run('working', async (local) => apply(await local.downloadLocalModel()))

  const select = () =>
    run('verifying', async (local) => {
      const outcome: LocalModelSelectOutcome = await local.selectExistingLocalModel()
      apply(outcome.state)
      if (!outcome.ok && !('cancelled' in outcome) && mountedRef.current) setNote(outcome.error.message)
    })

  const cancel = async () => {
    if (busyRef.current || !(await appConfirm(d.confirmCancel))) return
    await run('working', async (local) => apply(await local.cancelLocalModelDownload()))
  }

  const remove = async () => {
    if (busyRef.current) return
    const message =
      state?.source === 'selected'
        ? d.confirmForget
        : fill(d.confirmDelete, { size: formatModelBytes(state?.totalBytes ?? 0) })
    if (!(await appConfirm(message, { tone: 'danger' }))) return
    await run('working', async (local) => apply(await local.deleteLocalModel()))
  }

  const redownload = async () => {
    if (busyRef.current) return
    const message = fill(d.confirmRedownload, { size: formatModelBytes(state?.totalBytes ?? 0) })
    if (!(await appConfirm(message, { tone: 'warning' }))) return
    await run('working', async (local) => {
      // the new download starts only once the old copy is really gone
      let deleted: LocalModelState
      try {
        deleted = await local.deleteLocalModel()
      } catch {
        if (mountedRef.current) setNote(d.deleteFailed)
        return
      }
      apply(deleted)
      if (deleted.status !== 'not-installed') {
        if (mountedRef.current) setNote(d.deleteFailed)
        return
      }
      apply(await local.downloadLocalModel())
    })
  }

  if (!state) {
    return (
      <SettingsCard title={d.title} subtitle={d.desc} icon="ai" className="set-localmodel">
        <div className="set-field-desc" role={failed ? 'alert' : 'status'}>
          {failed ? d.unavailable : d.loading}
        </div>
      </SettingsCard>
    )
  }

  const total = formatModelBytes(state.totalBytes)
  const disabled = busy !== null
  const partial = state.partialBytes ?? 0
  const statusLabel =
    state.status === 'ready'
      ? d.ready
      : state.status === 'downloading'
        ? d.downloading
        : state.status === 'error'
          ? d.error
          : d.notInstalled
  const statusKind =
    state.status === 'ready'
      ? 'ok'
      : state.status === 'error'
        ? 'err'
        : state.status === 'downloading'
          ? 'testing'
          : ''
  const done = state.doneBytes ?? 0
  const pct = state.totalBytes > 0 ? Math.min(100, Math.floor((done / state.totalBytes) * 100)) : 0

  return (
    <SettingsCard title={d.title} subtitle={d.desc} icon="ai" className="set-localmodel">
      <SettingsRow
        label={d.model}
        control={
          <span className="set-localmodel-value" data-testid="local-model-name">
            {MODEL_NAME} · {total}
          </span>
        }
      />
      <SettingsRow
        label={d.status}
        control={
          <span
            className={statusKind ? `set-ai-status ${statusKind}` : 'set-localmodel-value'}
            role="status"
            data-testid="local-model-status"
            data-status={state.status}
          >
            {statusKind === 'testing' && <span className="set-ai-spin" aria-hidden="true" />}
            <span className="set-ai-status-text">{statusLabel}</span>
          </span>
        }
      />

      {state.status === 'downloading' && (
        <div className="set-localmodel-progress">
          <progress max={state.totalBytes} value={done} aria-label={d.downloading} />
          <span className="set-field-desc">
            {fill(d.progress, { done: formatModelBytes(done), total, pct })}
          </span>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="set-field-desc set-localmodel-path">
          {state.source === 'selected'
            ? fill(d.sourceSelected, { path: state.path ?? '' })
            : d.sourceDownloaded}
        </div>
      )}

      {state.status !== 'downloading' && state.status !== 'ready' && partial > 0 && (
        <div className="set-field-desc">{fill(d.partial, { done: formatModelBytes(partial) })}</div>
      )}

      {state.status === 'error' && state.error && (
        <div className="set-field-desc set-localmodel-error" role="alert">
          {state.error.message}
        </div>
      )}

      {note && (
        <div className="set-field-desc set-localmodel-error" role="alert">
          {note}
        </div>
      )}

      {busy && (
        <div className="set-field-desc" role="status">
          {busy === 'verifying' ? d.verifying : d.working}
        </div>
      )}

      <div className="set-localmodel-actions">
        {state.status === 'not-installed' && (
          <>
            <button className="set-btn primary" type="button" disabled={disabled} onClick={download}>
              {partial > 0 ? d.resume : d.download}
            </button>
            <button className="set-btn" type="button" disabled={disabled} onClick={select}>
              {d.select}
            </button>
          </>
        )}
        {state.status === 'downloading' && (
          <button className="set-btn" type="button" disabled={disabled} onClick={cancel}>
            {d.cancel}
          </button>
        )}
        {state.status === 'ready' && (
          <>
            <button className="set-btn" type="button" disabled={disabled} onClick={redownload}>
              {d.redownload}
            </button>
            <button className="set-btn" type="button" disabled={disabled} onClick={remove}>
              {d.delete}
            </button>
          </>
        )}
        {state.status === 'error' && (
          <>
            <button className="set-btn primary" type="button" disabled={disabled} onClick={download}>
              {partial > 0 ? d.resume : d.retry}
            </button>
            <button className="set-btn" type="button" disabled={disabled} onClick={select}>
              {d.select}
            </button>
            {partial > 0 && (
              <button className="set-btn" type="button" disabled={disabled} onClick={remove}>
                {d.delete}
              </button>
            )}
          </>
        )}
      </div>
    </SettingsCard>
  )
}
