import { useEffect, useRef, useState } from 'react'
import './gemini-model-picker.css'

export interface GeminiPickerModel {
  id: string
  displayName: string
  description: string
  usableForChat: boolean
}

const CHOICE_KEY = 'genoffice-gemini-model-choice-v1'
const MODELS_KEY = 'genoffice-gemini-models-v1'
const USAGE_KEY = 'genoffice-gemini-usage-v1'
const ROUTING_LOG_KEY = 'genoffice-gemini-routing-log-v1'
const CALL_LOG_KEY = 'genoffice-gemini-call-log-v1'
const CHANGE_EVENT = 'genoffice-gemini-routing-changed'
const DEFAULTS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]

function readChoice(): string {
  try {
    return localStorage.getItem(CHOICE_KEY) || 'auto'
  } catch {
    return 'auto'
  }
}

function readUsage(): Record<string, number> {
  try {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
    const saved = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') as {
      date?: string
      counts?: Record<string, number>
    }
    return saved.date === date && saved.counts ? saved.counts : {}
  } catch {
    return {}
  }
}

interface RoutingLogEntry {
  at: number
  model: string
  action: 'selected' | 'retry' | 'fallback' | 'exhausted'
  reason?: 'daily_quota' | 'rate_limit' | 'overloaded' | 'timeout' | 'unavailable' | 'other'
  to?: string
  delayMs?: number
}

interface CallLogEntry {
  id: string
  at: number
  model: string
  purpose: 'chat' | 'generation' | 'compaction'
  messageCount: number
  inputTextChars: number
  toolNames: string[]
  status: 'pending' | 'ok' | 'error' | 'cancelled' | 'interrupted'
  durationMs?: number
  reason?: RoutingLogEntry['reason'] | 'network'
  httpStatus?: number
  quotaId?: string
  quotaMetric?: string
  retryAfterSeconds?: number
  usage?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
    totalTokenCount?: number
  }
}

function readCallLog(): CallLogEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CALL_LOG_KEY) || '[]') as unknown
    return Array.isArray(saved)
      ? saved.filter(
          (entry): entry is CallLogEntry =>
            !!entry &&
            typeof entry === 'object' &&
            Number.isFinite(entry.at) &&
            entry.at >= Date.now() - 7 * 24 * 60 * 60_000 &&
            entry.at <= Date.now() &&
            typeof entry.model === 'string' &&
            typeof entry.status === 'string',
        )
      : []
  } catch {
    return []
  }
}

function readRoutingLog(): RoutingLogEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ROUTING_LOG_KEY) || '[]') as unknown
    if (!Array.isArray(saved)) return []
    return saved.filter(
      (entry): entry is RoutingLogEntry =>
        !!entry &&
        typeof entry === 'object' &&
        Number.isFinite(entry.at) &&
        entry.at >= Date.now() - 7 * 24 * 60 * 60_000 &&
        entry.at <= Date.now() &&
        typeof entry.model === 'string' &&
        ['selected', 'retry', 'fallback', 'exhausted'].includes(entry.action),
    )
  } catch {
    return []
  }
}

function reasonLabel(reason: CallLogEntry['reason'], vi: boolean): string {
  return {
    daily_quota: vi ? 'hết hạn mức ngày' : 'daily quota',
    rate_limit: vi ? 'giới hạn tốc độ' : 'rate limit',
    overloaded: vi ? 'quá tải' : 'overloaded',
    timeout: vi ? 'quá thời gian chờ' : 'timed out',
    unavailable: vi ? 'model không khả dụng' : 'model unavailable',
    network: vi ? 'lỗi mạng' : 'network error',
    other: vi ? 'lỗi khác' : 'other error',
  }[reason || 'other']
}

function describeCall(entry: CallLogEntry, vi: boolean): string {
  const task =
    {
      chat: vi ? 'trò chuyện / thao tác' : 'chat / tools',
      generation: vi ? 'tạo nội dung' : 'content generation',
      compaction: vi ? 'rút gọn ngữ cảnh' : 'context compaction',
    }[entry.purpose] || entry.purpose
  const result =
    entry.status === 'ok'
      ? vi
        ? 'xong'
        : 'done'
      : entry.status === 'pending'
        ? vi
          ? 'đang chạy'
          : 'running'
        : entry.status === 'cancelled'
          ? vi
            ? 'đã hủy'
            : 'cancelled'
          : entry.status === 'interrupted'
            ? vi
              ? 'bị gián đoạn'
              : 'interrupted'
            : `${entry.httpStatus || ''} ${reasonLabel(entry.reason, vi)}`.trim()
  return `${task} · ${result}`
}

function describeRouting(entry: RoutingLogEntry, vi: boolean): string {
  const reason = reasonLabel(entry.reason, vi)
  if (entry.action === 'selected') return `${entry.model} · ${vi ? 'đã chọn' : 'selected'}`
  if (entry.action === 'retry')
    return `${entry.model} · ${vi ? 'thử lại' : 'retry'} (${reason}, ${entry.delayMs ?? 0} ms)`
  if (entry.action === 'fallback') return `${entry.model} → ${entry.to} · ${reason}`
  return `${entry.model} · ${vi ? 'đã dừng chuyển model' : 'routing stopped'} (${reason})`
}

/** Compact model selector shared by all six chat panels. */
export function GeminiModelPicker({
  getProvider,
  loadModels,
  lang,
}: {
  getProvider(): string | undefined
  loadModels(): Promise<GeminiPickerModel[]>
  lang: string
}) {
  const getProviderRef = useRef(getProvider)
  const loadModelsRef = useRef(loadModels)
  const logDialogRef = useRef<HTMLDialogElement>(null)
  getProviderRef.current = getProvider
  loadModelsRef.current = loadModels
  const [provider, setProvider] = useState(getProvider())
  const [choice, setChoice] = useState(readChoice)
  const [models, setModels] = useState<GeminiPickerModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [usage, setUsage] = useState(readUsage)
  const [routingLog, setRoutingLog] = useState(readRoutingLog)
  const [callLog, setCallLog] = useState(readCallLog)

  useEffect(() => {
    const timer = setInterval(() => setProvider(getProviderRef.current()), 2_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (provider !== 'gemini') return
    let active = true
    setLoading(true)
    void loadModelsRef
      .current()
      .then((result) => {
        if (!active) return
        setModels(result)
        setError('')
        try {
          localStorage.setItem(MODELS_KEY, JSON.stringify(result))
        } catch {
          /* cache optional */
        }
      })
      .catch(() => {
        if (active)
          setError(
            lang === 'vi'
              ? 'Không tải được danh sách model; dùng mặc định.'
              : 'Could not load models; using defaults.',
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [provider, lang])
  useEffect(() => {
    const changed = (event: Event) => {
      setChoice(readChoice())
      setUsage(readUsage())
      setRoutingLog(readRoutingLog())
      setCallLog(readCallLog())
      const detail = (event as CustomEvent<{ from?: string; to?: string }>).detail
      if (detail?.to) setNotice(`${detail.from} → ${detail.to}`)
    }
    window.addEventListener(CHANGE_EVENT, changed)
    return () => window.removeEventListener(CHANGE_EVENT, changed)
  }, [])

  if (provider !== 'gemini') return null
  const vi = lang === 'vi'
  const available = models.filter((model) => model.usableForChat)
  const other = models.filter((model) => !model.usableForChat)
  const fallback = DEFAULTS.map((id) => ({
    id,
    displayName: id,
    description: '',
    usableForChat: true,
  }))
  const used = choice.startsWith('model:')
    ? usage[choice.slice(6)] || 0
    : Object.values(usage).reduce((total, count) => total + count, 0)
  const latest = routingLog[0]
  const latestCall = callLog[0]
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const callsToday = callLog.filter(
    (entry) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(entry.at)) === today,
  )
  const tokensToday = callsToday.reduce(
    (total, entry) => total + (entry.usage?.totalTokenCount || 0),
    0,
  )
  const measuredToday = callsToday.filter(
    (entry) => entry.usage?.totalTokenCount !== undefined,
  ).length
  const modelStats = new Map<
    string,
    { calls: number; ok: number; busy: number; tokens: number; measured: number }
  >()
  for (const entry of callsToday) {
    const row = modelStats.get(entry.model) || { calls: 0, ok: 0, busy: 0, tokens: 0, measured: 0 }
    row.calls++
    if (entry.status === 'ok') row.ok++
    if (
      entry.httpStatus === 429 ||
      entry.httpStatus === 503 ||
      entry.httpStatus === 529 ||
      entry.reason === 'rate_limit' ||
      entry.reason === 'overloaded'
    )
      row.busy++
    if (entry.usage?.totalTokenCount !== undefined) {
      row.tokens += entry.usage.totalTokenCount
      row.measured++
    }
    modelStats.set(entry.model, row)
  }
  const select = (value: string) => {
    try {
      localStorage.setItem(CHOICE_KEY, value)
    } catch {
      /* session only */
    }
    setChoice(value)
    setNotice('')
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
  return (
    <div className="ai-model-picker">
      <label className="ai-model-picker-control">
        <span aria-hidden>✦</span>
        <span className="sr-only">
          {vi ? 'Model Gemini cho cuộc trò chuyện' : 'Gemini chat model'}
        </span>
        <select value={choice} onChange={(event) => select(event.target.value)}>
          <optgroup label={vi ? 'Chế độ' : 'Mode'}>
            <option value="auto">{vi ? 'Tự động' : 'Auto'} · Flash → Lite</option>
            <option value="smart">{vi ? 'Khôn · chỉ Flash' : 'Smart · Flash only'}</option>
            <option value="fast">{vi ? 'Nhanh · chỉ Flash-Lite' : 'Fast · Flash-Lite only'}</option>
          </optgroup>
          <optgroup
            label={`${vi ? 'Dùng được trong chat' : 'Chat models'} (${available.length || fallback.length})`}
          >
            {choice.startsWith('model:') &&
              !(models.length ? available : fallback).some(
                (model) => `model:${model.id}` === choice,
              ) && (
                <option value={choice}>
                  {choice.slice(6)} · {vi ? 'lựa chọn đã lưu' : 'saved choice'}
                </option>
              )}
            {(models.length ? available : fallback).map((model) => (
              <option key={model.id} value={`model:${model.id}`}>
                {model.displayName} · {model.id} · {usage[model.id] || 0} {vi ? 'lượt' : 'calls'}
              </option>
            ))}
          </optgroup>
          {other.length > 0 && (
            <optgroup
              label={`${vi ? 'Model khác' : 'Other models'} (${other.length}, ${vi ? 'không dùng cho chat' : 'not for chat'})`}
            >
              {other.map((model) => (
                <option key={model.id} disabled>
                  {model.displayName} · {model.id}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <span
        className="ai-model-picker-status"
        title={
          notice ||
          error ||
          (vi
            ? 'Số lượt là ước tính trên app này; hạn mức thực tế xem trong Google AI Studio'
            : 'Calls are estimated in this app; view actual limits in Google AI Studio')
        }
      >
        {notice ||
          (loading
            ? vi
              ? 'Đang tải model…'
              : 'Loading models…'
            : error ||
              (latestCall
                ? `${latestCall.model} · ${describeCall(latestCall, vi)}`
                : latest
                  ? describeRouting(latest, vi)
                  : vi
                    ? `${used} lượt ghi nhận hôm nay · hạn mức không rõ`
                    : `${used} calls recorded today · quota unknown`))}
      </span>
      <button
        className="ai-model-picker-log-button"
        type="button"
        onClick={() => logDialogRef.current?.showModal()}
      >
        {vi ? 'Nhật ký' : 'Log'}
      </button>
      <dialog ref={logDialogRef} className="ai-model-picker-log-dialog">
        <div className="ai-model-picker-log-header">
          <strong>{vi ? 'Chẩn đoán Gemini' : 'Gemini diagnostics'}</strong>
          <button
            type="button"
            aria-label={vi ? 'Đóng nhật ký' : 'Close log'}
            onClick={() => logDialogRef.current?.close()}
          >
            ×
          </button>
        </div>
        <div className="ai-model-picker-log-content">
          <strong>{vi ? 'Lượt chat Gemini' : 'Gemini chat calls'}</strong>
          <p>
            {vi
              ? `${callsToday.length} lượt hôm nay · ${measuredToday} lượt có số token · ${tokensToday.toLocaleString('vi-VN')} token đã đo. Log tự xóa sau 7 ngày, tối đa 200 lượt / 128 KB. Không lưu nội dung tài liệu hoặc API key.`
              : `${callsToday.length} calls today · ${measuredToday} with token counts · ${tokensToday.toLocaleString('en-US')} measured tokens. Logs expire after 7 days, capped at 200 calls / 128 KB. No document content or API keys stored.`}
          </p>
          {modelStats.size > 0 && (
            <table className="ai-model-picker-stats">
              <thead>
                <tr>
                  <th>{vi ? 'Model' : 'Model'}</th>
                  <th>{vi ? 'Lượt' : 'Calls'}</th>
                  <th>{vi ? 'Xong' : 'Done'}</th>
                  <th>{vi ? 'Bận/giới hạn' : 'Busy/limited'}</th>
                  <th>{vi ? 'Token đo được' : 'Measured tokens'}</th>
                </tr>
              </thead>
              <tbody>
                {[...modelStats].map(([model, stats]) => (
                  <tr key={model}>
                    <td>{model}</td>
                    <td>{stats.calls}</td>
                    <td>{stats.ok}</td>
                    <td>{stats.busy}</td>
                    <td>
                      {stats.tokens.toLocaleString(vi ? 'vi-VN' : 'en-US')} ({stats.measured})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {callLog.length ? (
            <ol className="ai-model-picker-calls">
              {callLog.map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>{entry.model}</strong> ·{' '}
                    <time dateTime={new Date(entry.at).toISOString()}>
                      {new Date(entry.at).toLocaleString(vi ? 'vi-VN' : 'en-US')}
                    </time>
                  </div>
                  <div>
                    {describeCall(entry, vi)}
                    {entry.durationMs !== undefined
                      ? ` · ${(entry.durationMs / 1000).toFixed(1)}s`
                      : ''}
                  </div>
                  <div>
                    {vi ? 'Token vào/ra/suy nghĩ/tổng' : 'Tokens in/out/thinking/total'}:{' '}
                    {entry.usage?.promptTokenCount ?? '?'} /{' '}
                    {entry.usage?.candidatesTokenCount ?? '?'} /{' '}
                    {entry.usage?.thoughtsTokenCount ?? '?'} / {entry.usage?.totalTokenCount ?? '?'}
                    {entry.usage?.cachedContentTokenCount !== undefined
                      ? ` · ${vi ? 'cache' : 'cached'} ${entry.usage.cachedContentTokenCount}`
                      : ''}
                  </div>
                  <div>
                    {entry.messageCount} {vi ? 'tin nhắn' : 'messages'} · {entry.inputTextChars}{' '}
                    {vi ? 'ký tự văn bản gửi đi' : 'input text characters'}
                    {entry.toolNames?.length ? ` · ${entry.toolNames.join(', ')}` : ''}
                  </div>
                  {(entry.quotaId ||
                    entry.quotaMetric ||
                    entry.retryAfterSeconds !== undefined) && (
                    <div>
                      {entry.quotaId || entry.quotaMetric}
                      {entry.retryAfterSeconds !== undefined
                        ? ` · ${vi ? 'thử lại sau' : 'retry after'} ${entry.retryAfterSeconds}s`
                        : ''}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>{vi ? 'Chưa có lượt gọi nào được ghi.' : 'No calls recorded yet.'}</p>
          )}
          <strong>{vi ? 'Chuyển model' : 'Model routing'}</strong>
          {routingLog.length ? (
            <ol>
              {routingLog.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleString(vi ? 'vi-VN' : 'en-US')}
                  </time>{' '}
                  {describeRouting(entry, vi)}
                </li>
              ))}
            </ol>
          ) : (
            <p>{vi ? 'Chưa có hoạt động nào được ghi.' : 'No activity recorded yet.'}</p>
          )}
        </div>
      </dialog>
    </div>
  )
}
