import { SettingsCard, SettingsRow } from './settings-ui/SettingsCard'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AGY_CHAT_DEFAULT_MODEL,
  type AgyChatApi,
  type AgyChatCatalog,
  type AgyChatModelInfo,
} from '@genoffice/ai-provider/agy-chat'
import { useI18n } from '../locale'

const EN = {
  title: 'Models in the chat box',
  desc: 'Only the models switched on here appear in the chat box. On a first run every Gemini model the Antigravity CLI reports is switched on, and chat starts on Gemini 3.8 Flash High when that CLI has it. Lower-effort models use less quota. Claude and GPT models stay off until you turn them on; a list you have already changed is kept as it is.',
  geminiGroup: 'Gemini',
  otherGroup: 'Claude and GPT',
  otherNote:
    'These draw on a separate quota pool and use several times more of it for the same work. They are off by default.',
  recommended: 'Recommended',
  fast: 'Fast',
  balanced: 'Balanced',
  slow: 'Slower',
  cost: '{n}× quota',
  loading: 'Reading the model list…',
  unavailable: 'Could not read the model list. Check the Antigravity connection above.',
  keepOne: 'At least one model has to stay on.',
}
const VI: typeof EN = {
  title: 'Model trong khung chat',
  desc: 'Chỉ các model được bật ở đây mới hiện trong khung chat. Khi dùng lần đầu, mọi model Gemini mà Antigravity CLI báo là được bật, và chat dùng Gemini 3.8 Flash High nếu CLI đó có. Model mức reasoning thấp hơn dùng ít quota hơn. Model Claude và GPT tắt cho tới khi bạn bật; danh sách bạn đã thay đổi sẽ được giữ nguyên.',
  geminiGroup: 'Gemini',
  otherGroup: 'Claude và GPT',
  otherNote:
    'Nhóm này dùng hạn mức riêng và tốn nhiều gấp nhiều lần cho cùng một việc. Mặc định tắt.',
  recommended: 'Khuyên dùng',
  fast: 'Nhanh',
  balanced: 'Cân bằng',
  slow: 'Chậm hơn',
  cost: 'Quota ×{n}',
  loading: 'Đang đọc danh sách model…',
  unavailable: 'Không đọc được danh sách model. Hãy kiểm tra kết nối Antigravity ở trên.',
  keepOne: 'Phải giữ bật ít nhất một model.',
}
const ZH: typeof EN = {
  title: '聊天框中的模型',
  desc: '只有在此开启的模型才会出现在聊天框中。首次使用时，Antigravity CLI 报告的所有 Gemini 模型都会开启，若该 CLI 提供 Gemini 3.8 Flash High，聊天默认使用它。较低思考档位的模型消耗更少额度。Claude 和 GPT 模型默认关闭，需手动开启；已修改过的列表保持不变。',
  geminiGroup: 'Gemini',
  otherGroup: 'Claude 和 GPT',
  otherNote: '这些模型使用单独的额度池，完成同样的工作要多消耗数倍额度。默认关闭。',
  recommended: '推荐',
  fast: '快速',
  balanced: '均衡',
  slow: '较慢',
  cost: '额度 ×{n}',
  loading: '正在读取模型列表…',
  unavailable: '无法读取模型列表。请检查上方的 Antigravity 连接。',
  keepOne: '至少保留一个模型。',
}
const DICTS: Record<string, typeof EN> = { en: EN, vi: VI, zh: ZH }

function api(): AgyChatApi | undefined {
  return (window as unknown as { agyChat?: AgyChatApi }).agyChat
}

/** Settings → AI model (Antigravity): which models the chat box offers. */
export function AgyChatModelsSettings() {
  const { lang } = useI18n()
  const d = DICTS[lang] ?? EN
  const [catalog, setCatalog] = useState<AgyChatCatalog | null>(null)
  const [failed, setFailed] = useState(false)
  // the newest catalog the panel has seen, so a queued toggle never starts from a stale list
  const catalogRef = useRef<AgyChatCatalog | null>(null)
  // toggles run one after another, each seeing the result of the previous one
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const load = useCallback(async () => {
    try {
      const next = await api()?.getAgyChatCatalog()
      if (next && next.all.length > 0) {
        catalogRef.current = next
        setCatalog(next)
        setFailed(false)
      } else {
        catalogRef.current = null
        setCatalog(null)
        setFailed(true)
      }
    } catch {
      catalogRef.current = null
      setCatalog(null)
      setFailed(true)
    }
  }, [])
  useEffect(() => {
    void load()
    const off = api()?.onAgyChatModelChanged?.(() => void load())
    const onWindow = () => void load()
    window.addEventListener('genoffice-agy-model-changed', onWindow)
    return () => {
      off?.()
      window.removeEventListener('genoffice-agy-model-changed', onWindow)
    }
  }, [load])

  const toggle = (id: string) => {
    // toggles are serialised: two rapid clicks cannot both start from the same snapshot and
    // silently drop one of them
    queueRef.current = queueRef.current.then(async () => {
      const current = catalogRef.current
      if (!current) return
      const on = current.enabled.includes(id)
      if (on && current.enabled.length === 1) return
      const ids = on ? current.enabled.filter((x) => x !== id) : [...current.enabled, id]
      try {
        const saved = await api()?.setAgyChatEnabledModels(ids)
        if (saved === null || saved === undefined) {
          // the write did not land: re-read so the switches show what is really stored instead of
          // pretending the change was saved
          void load()
          return
        }
        const next = { ...current, enabled: saved }
        catalogRef.current = next
        setFailed(false)
        setCatalog(next)
        window.dispatchEvent(new Event('genoffice-agy-model-changed'))
      } catch {
        void load()
      }
    })
  }

  const row = (model: AgyChatModelInfo) => {
    const on = catalog?.enabled.includes(model.id) ?? false
    const last = on && (catalog?.enabled.length ?? 0) === 1
    const speed = model.speed === 'fast' ? d.fast : model.speed === 'slow' ? d.slow : d.balanced
    return (
      <SettingsRow className="set-field" key={model.id}>
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">
              {model.label}
              {model.id === AGY_CHAT_DEFAULT_MODEL && (
                <span className="set-chatmodel-badge">{d.recommended}</span>
              )}
            </div>
            <div className="set-field-desc">
              {model.id} · {speed} · {d.cost.replace('{n}', String(model.relativeCost))}
            </div>
          </div>
        </div>
        <button
          className="set-switch"
          role="switch"
          aria-checked={on}
          aria-label={model.label}
          title={last ? d.keepOne : undefined}
          disabled={last}
          onClick={() => void toggle(model.id)}
        />
      </SettingsRow>
    )
  }

  const all = catalog?.all ?? []
  const gemini = all.filter((model) => model.family === 'gemini')
  const others = all.filter((model) => model.family !== 'gemini')

  return (
    <SettingsCard title={d.title} subtitle={d.desc} icon="ai">
      {!catalog && !failed && <p className="set-field-desc">{d.loading}</p>}
      {failed && <p className="set-field-desc">{d.unavailable}</p>}
      {gemini.length > 0 && <div className="set-group-body">{gemini.map(row)}</div>}
      {others.length > 0 && (
        <details className="set-chatmodels-other">
          <summary>{d.otherGroup}</summary>
          <p className="set-field-desc">{d.otherNote}</p>
          <div className="set-group-body">{others.map(row)}</div>
        </details>
      )}
    </SettingsCard>
  )
}
