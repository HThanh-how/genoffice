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
  getProviderRef.current = getProvider
  loadModelsRef.current = loadModels
  const [provider, setProvider] = useState(getProvider())
  const [choice, setChoice] = useState(readChoice)
  const [models, setModels] = useState<GeminiPickerModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [usage, setUsage] = useState(readUsage)

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
              (vi
                ? `${used} lượt ghi nhận hôm nay · ${models.length} model · hạn mức không rõ`
                : `${used} calls recorded today · ${models.length} models · quota unknown`))}
      </span>
    </div>
  )
}
