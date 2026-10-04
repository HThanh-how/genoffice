import { appNotify } from './ui-feedback'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { UpdateSource } from '../../shared/update-source'
import { OpeningEffectsSettings } from './fork/OpeningEffectsSettings'
import { AiInstructionsSettings, aiInstructionsTitle } from './fork/AiInstructionsSettings'
import {
  AI_CUSTOM_FONT_MAX_PX,
  AI_CUSTOM_FONT_MIN_PX,
  DEFAULT_AI_PANEL_PREFS,
  Dropdown,
  aiPanelFontPx,
  clampAiCustomFontSize,
} from '@genoffice/ui'
import type { AiFontSize, AiPanelPrefs, AiPanelSide } from '@genoffice/ui'
import type {
  DefaultAppStatus,
  FileSearchSettings,
  JevEndpoint,
  LegacyDocSettings,
  LegacyRecoveryEntry,
} from '../../shared/home-api'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  clampMaxOutputTokens,
} from '@genoffice/ai-provider/browser'
import type {
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiMediaSettings,
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
} from '@genoffice/ai-provider'
import { useI18n } from './locale'
import type { StringKey, TFunc } from './locale'
import type { AiCatalogEntry, UiTheme } from '../../shared/home-api'
import { ProviderLogo } from './provider-logos'
import { IntegrationsPane, skillUpdateDue } from './IntegrationsPane'
import { DocumentMemorySettings } from './DocumentMemorySettings'
import { ClipboardSettingsToggle } from './fork/ClipboardSettingsToggle'
import { DefaultFolderToggle } from './fork/DefaultFolderToggle'
import { ClipboardHistorySettings } from './fork/ClipboardHistorySettings'
import { AgyProviderFields, ProviderNote, testAiSettingsFor } from './fork/AgyProviderFields'
import { AgyMediaFields } from './fork/AgyMediaFields'
import { AgyChatModelsSettings } from './fork/AgyChatModelsSettings'
import { agyMediaTestConfig } from './fork/agy-media-state'
import { agyString } from './fork/agy-strings'
import './settings.css'

// ── Settings modal (opened from the account menu) ─────────
// Genspark-style two-pane dialog: section nav on the left, fields on the right.
// All values go through the existing home IPC; nothing is stored locally.

// sorted by ISO 639 language code — native-script labels have no natural
// shared alphabet, so the code is the ordering key
const LANG_OPTIONS = [
  { value: 'ar', label: 'العربية' },
  { value: 'cs', label: 'Čeština' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'he', label: 'עברית' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
] as const

type GroupKey =
  'appearance' | 'ai' | 'files' | 'legacy' | 'legacyHint' | 'privacy' | 'opening' | 'openingHint'
const GROUP_TEXT: Record<string, Record<GroupKey, string>> = {
  en: {
    appearance: 'Appearance',
    ai: 'AI panel',
    files: 'Files & saving',
    legacy: 'Legacy Office files',
    legacyHint: '.doc and .ppt conversion',
    privacy: 'Privacy & clipboard',
    opening: 'Opening effects',
    openingHint: 'A scene while a file opens',
  },
  vi: {
    appearance: 'Giao diện',
    ai: 'Bảng AI',
    files: 'Tệp & lưu',
    legacy: 'Tệp Office cũ',
    legacyHint: 'Chuyển đổi .doc và .ppt',
    privacy: 'Riêng tư & clipboard',
    opening: 'Hiệu ứng mở tệp',
    openingHint: 'Cảnh chạy khi mở một tệp',
  },
  zh: {
    appearance: '外观',
    ai: 'AI 面板',
    files: '文件与保存',
    legacy: '旧版 Office 文件',
    legacyHint: '.doc 和 .ppt 转换',
    privacy: '隐私与剪贴板',
    opening: '打开动画',
    openingHint: '打开文件时播放的场景',
  },
  'zh-TW': {
    appearance: '外觀',
    ai: 'AI 面板',
    files: '檔案與儲存',
    legacy: '舊版 Office 檔案',
    legacyHint: '.doc 與 .ppt 轉換',
    privacy: '隱私與剪貼簿',
    opening: '開啟動畫',
    openingHint: '開啟檔案時播放的場景',
  },
}
function groupText(lang: string, key: GroupKey): string {
  return (GROUP_TEXT[lang] ?? GROUP_TEXT.en!)[key]
}

type GroupIconId = 'appearance' | 'ai' | 'files' | 'privacy' | 'legacy' | 'opening'
const GROUP_ICONS: Record<GroupIconId, string> = {
  appearance: 'M12 3a9 9 0 1 0 9 9h-9zM12 3v9h9',
  ai: 'M4 4h16v13H9l-5 4zM8 9h8m-8 4h5',
  files: 'M3 6h7l2 3h9v11H3z',
  privacy: 'M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6zM9 12l2 2 4-4',
  legacy: 'M7 3h7l4 4v14H7zM14 3v5h4M10 13h5m-5 4h5',
  opening: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
}
function groupHint(lang: string, key: 'appearance' | 'ai' | 'files' | 'privacy'): string {
  const hints = {
    appearance: ['Language, theme and reading comfort', 'Ngôn ngữ, màu giao diện và cách hiển thị'],
    ai: ['Make the assistant fit your workflow', 'Điều chỉnh trợ lý theo cách bạn làm việc'],
    files: ['Default folders and automatic saving', 'Thư mục mặc định và lưu tự động'],
    privacy: [
      'Choose what the app remembers and shares',
      'Chọn dữ liệu ứng dụng ghi nhớ và chia sẻ',
    ],
  }
  return hints[key][lang === 'vi' ? 1 : 0]!
}

/** Related settings share one card; advanced cards are collapsed by default. */
function SetGroup({
  title,
  hint,
  fold,
  icon = 'ai',
  children,
}: {
  title: string
  hint?: string
  fold?: boolean
  icon?: GroupIconId
  children: ReactNode
}) {
  const heading = (
    <>
      <span className="set-group-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path
            d={GROUP_ICONS[icon]}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="set-group-text">
        <span>{title}</span>
        {hint && <span className="set-group-hint">{hint}</span>}
      </span>
    </>
  )
  if (fold)
    return (
      <details className="set-group set-group-fold">
        <summary className="set-group-title">{heading}</summary>
        <div className="set-group-body">{children}</div>
      </details>
    )
  return (
    <section className="set-group" aria-label={title}>
      <h4 className="set-group-title">{heading}</h4>
      <div className="set-group-body">{children}</div>
    </section>
  )
}

// GenMail's option order: follow-system first, then the manual picks
const THEME_OPTIONS = [
  { value: 'system', labelKey: 'themeSystem' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: UiTheme; labelKey: StringKey }[]

const AI_FONT_SIZE_OPTIONS = [
  { value: 'default', labelKey: 'aiFontSizeDefault' },
  { value: 'large', labelKey: 'aiFontSizeLarge' },
  { value: 'xlarge', labelKey: 'aiFontSizeXLarge' },
  { value: 'custom', labelKey: 'aiFontSizeCustom' },
] as const satisfies readonly { value: AiFontSize; labelKey: StringKey }[]

const CHANNEL_OPTIONS = [
  { value: 'stable', labelKey: 'channelStable' },
  { value: 'beta', labelKey: 'channelBeta' },
] as const satisfies readonly { value: 'stable' | 'beta'; labelKey: StringKey }[]

/** GitHub-style abbreviated stargazer count (2591 → "2.6k") — the number is
 * social proof, not a metric; the cached/exact value would only look stale */
function formatStars(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10).toString().replace(/\.0$/, '')}k`
}

/** px stepper for the custom AI panel text size; in-range values apply live,
 * out-of-range or partial input is clamped on blur */
function CustomFontSizeInput({
  value,
  label,
  onCommit,
}: {
  value: number
  label: string
  onCommit: (px: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : String(value)
  const commit = (raw: string) => {
    const px = clampAiCustomFontSize(raw)
    if (px !== null && px !== value) onCommit(px)
  }
  return (
    <label className="set-num">
      <input
        type="number"
        className="set-input set-num-input"
        aria-label={label}
        min={AI_CUSTOM_FONT_MIN_PX}
        max={AI_CUSTOM_FONT_MAX_PX}
        step={1}
        value={shown}
        onFocus={() => {
          setDraft(String(value))
          setEditing(true)
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= AI_CUSTOM_FONT_MIN_PX && n <= AI_CUSTOM_FONT_MAX_PX) {
            onCommit(n)
          }
        }}
        onBlur={() => {
          commit(draft)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span className="set-num-unit">px</span>
    </label>
  )
}

export type SectionId = 'aiModel' | 'aiMedia' | 'general' | 'integrations' | 'about'

const SECTIONS: readonly { id: SectionId; labelKey: StringKey }[] = [
  { id: 'aiModel', labelKey: 'setSecAiModel' },
  { id: 'aiMedia', labelKey: 'setSecAiMedia' },
  { id: 'general', labelKey: 'setSecGeneral' },
  { id: 'integrations', labelKey: 'setSecIntegrations' },
  { id: 'about', labelKey: 'setSecAbout' },
]

function SectionIcon({ id }: { id: SectionId }) {
  if (id === 'aiModel') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.8 9.5 6l4.2 1.5L9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6 8 1.8Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M12.8 11.2v3M11.3 12.7h3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'aiMedia') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.5 11.5 6 8l2.5 2.5L10.5 9l3 2.8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="10.5" cy="6" r="1.1" fill="currentColor" />
      </svg>
    )
  }
  if (id === 'integrations') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0V5ZM8 11.5V14"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (id === 'general') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 5h8M13 5h1M2 11h1M6 11h8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle cx="11.5" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.5" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.4v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
    </svg>
  )
}

/** label-over-value field row with an optional right-aligned action */
function Field({
  label,
  value,
  valueTitle,
  action,
}: {
  label: string
  value: string
  valueTitle?: string
  action?: ReactNode
}) {
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-label">{label}</div>
        <div className="set-field-value" data-tip={valueTitle}>
          {value}
        </div>
      </div>
      {action}
    </div>
  )
}

/**
 * Long enough that typing an address does not fire a request per keystroke,
 * short enough that the picker is populated by the time the eye reaches it.
 */
const CUSTOM_MODELS_DEBOUNCE_MS = 400

/** replace one catalog entry's model list, leaving every other entry untouched */
function foldModels(providerId: string, models: string[]) {
  return (current: AiCatalogEntry[]): AiCatalogEntry[] =>
    current.map((entry) =>
      entry.id === providerId ? { ...entry, models, defaultModel: '' } : entry,
    )
}

/** AI model pane: provider / model / key / base URL, saved to userData/ai-settings.json */
function AiModelPane({ t }: { t: TFunc }) {
  const [catalog, setCatalog] = useState<AiCatalogEntry[]>(() =>
    (window.aiOffice.getAiProviders?.() ?? []).filter((entry) => entry.id !== 'genspark'),
  )
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [modelListState, setModelListState] = useState<'idle' | 'loading' | 'live' | 'fallback'>(
    'idle',
  )
  const [modelListCount, setModelListCount] = useState(0)
  const [modelRefresh, setModelRefresh] = useState(0)
  const [manualModel, setManualModel] = useState(false)
  const builtInCatalog = useRef(catalog)
  /** free-typed value of the output-cap field; committed (and clamped) on blur */
  const [maxTokensDraft, setMaxTokensDraft] = useState<string | null>(null)

  const refreshCodexModels = useCallback(async (cliPath = '', selectedModel = '') => {
    if (!window.aiOffice.getCodexModels) return
    const live = await window.aiOffice.getCodexModels(cliPath)
    setCatalog((current) =>
      current.map((entry) => {
        if (entry.id !== 'codex') return entry
        const models =
          selectedModel && !live.models.includes(selectedModel)
            ? [selectedModel, ...live.models]
            : live.models
        return { ...entry, models, defaultModel: live.defaultModel }
      }),
    )
  }, [])

  useEffect(() => {
    let alive = true
    void window.aiOffice.getAiSettings?.().then((s) => {
      if (!alive || !s) return
      // The switch is disabled with genspark, so never present it stranded
      // off. Display-only: s.provider may be the activeProvider fallback for
      // a half-configured BYOK selection, so writing anything back here would
      // clobber the stored choice — the main process heals a genuine legacy
      // genspark+off file itself, judged on the raw stored provider.
      if (s.provider === 'genspark' && s.gskToolsEnabled === false) {
        s = { ...s, gskToolsEnabled: true }
      }
      setSettings(s)
      const codex = s.providers.codex
      if (codex) {
        void refreshCodexModels(codex.cliPath ?? '', codex.model).catch(() => undefined)
      }
    })
    return () => {
      alive = false
    }
  }, [refreshCodexModels])

  // Probe only the selected provider, using its unsaved key and endpoint.
  // A stored custom server is never contacted while another provider is selected.
  const selectedProvider = settings?.provider
  const selectedMeta = catalog.find((entry) => entry.id === selectedProvider)
  const endpointProvider =
    selectedProvider === 'codex' || selectedProvider === 'genspark' ? undefined : selectedProvider
  const endpointConfig = settings ? settings.providers[settings.provider] : undefined
  const configuredBaseUrl = endpointConfig?.baseUrl?.trim() || ''
  const endpointBaseUrl = (configuredBaseUrl || selectedMeta?.defaultBaseUrl || '').trim()
  const endpointApiKey = endpointConfig?.apiKey ?? ''
  // The stored model decides where the pin goes below, but changing it must not
  // send another request, so it is read when the reply lands rather than keyed on.
  const selectedModelRef = useRef('')
  useEffect(() => {
    selectedModelRef.current = endpointConfig?.model ?? ''
  })
  /** Addresses that produced each provider's current live list. */
  const listedForRef = useRef(new Map<string, string>())

  useEffect(() => {
    setModelListState('idle')
    if (!endpointProvider) return
    // A list belonging to a different server — or to no server, once the address
    // is cleared — is misinformation, so it goes the moment the address changes:
    // the free-text box is the honest thing to show while the answer is unknown.
    const previousBase = listedForRef.current.get(endpointProvider)
    if (previousBase !== undefined && previousBase !== endpointBaseUrl) {
      listedForRef.current.delete(endpointProvider)
      const baseline = builtInCatalog.current.find((entry) => entry.id === endpointProvider)
      setCatalog(foldModels(endpointProvider, baseline?.models ?? []))
    }
    if (endpointProvider === 'custom' && !endpointBaseUrl) return
    if (
      !endpointApiKey.trim() &&
      endpointProvider !== 'custom' &&
      endpointProvider !== 'openrouter' &&
      endpointProvider !== 'opper'
    )
      return
    const canDiscover =
      window.aiOffice.getProviderModels ||
      (endpointProvider === 'gemini'
        ? window.aiOffice.getGeminiModels
        : selectedMeta?.needsBaseUrl
          ? window.aiOffice.getCustomModels
          : undefined)
    if (!canDiscover) return
    let cancelled = false
    const timer = setTimeout(() => {
      setModelListState('loading')
      const config = {
        apiKey: endpointApiKey,
        model: selectedModelRef.current,
        baseUrl: configuredBaseUrl || undefined,
      }
      const request = window.aiOffice.getProviderModels
        ? window.aiOffice.getProviderModels(endpointProvider, config)
        : endpointProvider === 'gemini'
          ? window.aiOffice.getGeminiModels!(endpointApiKey)
          : window.aiOffice.getCustomModels(endpointBaseUrl, endpointApiKey)
      void request
        .then((live) => {
          // A server that will not answer leaves the current list alone: a blip
          // must not wipe a picker mid-use.
          if (cancelled) return
          if (!live || live.models.length === 0) {
            setModelListState('fallback')
            return
          }
          // A hand-typed id is pinned to the top so it never vanishes from the
          // picker. The catalog is the only thing written — writing settings
          // here would revert whatever the user typed while the probe was in
          // flight, since `updateConfig` rebuilds them from its own render.
          const selected = selectedModelRef.current.trim()
          const models =
            selected && !live.models.includes(selected) ? [selected, ...live.models] : live.models
          listedForRef.current.set(endpointProvider, endpointBaseUrl)
          setCatalog(foldModels(endpointProvider, models))
          setModelListCount(live.models.length)
          setModelListState('live')
        })
        .catch(() => {
          if (!cancelled) setModelListState('fallback')
        })
    }, CUSTOM_MODELS_DEBOUNCE_MS)
    // React's own cleanup drops a superseded reply, so a slow answer from the
    // previous address can never overwrite a fast one from the current address.
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    endpointProvider,
    endpointBaseUrl,
    endpointApiKey,
    configuredBaseUrl,
    selectedMeta?.needsBaseUrl,
    modelRefresh,
  ])

  if (!settings) return null
  const provider = settings.provider
  const meta = catalog.find((c) => c.id === provider)
  const config = settings.providers[provider] ?? {
    apiKey: '',
    model: meta?.defaultModel ?? '',
    baseUrl: undefined,
    cliPath: undefined,
  }
  const isGenspark = provider === 'genspark'
  const isCodex = provider === 'codex'
  const isAgy = provider === 'agy'

  const touch = () => {
    setDirty(true)
    setSaved(false)
    setTestResult(null)
  }
  const updateConfig = (patch: Partial<typeof config>) => {
    setSettings({
      ...settings,
      providers: { ...settings.providers, [provider]: { ...config, ...patch } },
    })
    touch()
  }
  /** Commit the output-cap input: clamp what was typed and drop a no-op edit */
  const commitMaxTokens = () => {
    if (maxTokensDraft === null) return
    setMaxTokensDraft(null)
    const next = clampMaxOutputTokens(Number.parseInt(maxTokensDraft, 10))
    if (next === (settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)) return
    setSettings({ ...settings, maxOutputTokens: next })
    touch()
  }
  const selectProvider = (id: AiSettings['provider']) => {
    setManualModel(false)
    // cloud tools cannot be off with genspark (chat runs through gsk anyway)
    setSettings({
      ...settings,
      provider: id,
      ...(id === 'genspark' ? { gskToolsEnabled: true } : {}),
    })
    touch()
  }
  const save = () => {
    window.aiOffice
      .setAiSettings?.(settings)
      .then(() => {
        setDirty(false)
        setSaved(true)
      })
      .catch((error) => {
        appNotify(error instanceof Error ? error.message : String(error), 'error')
      })
  }
  const test = () => {
    setTesting(true)
    setTestResult(null)
    testAiSettingsFor(settings, t('setAiTestFail'))
      ?.then((r) => {
        setTestResult(r ?? { ok: false })
        if (r?.ok && isCodex) {
          void refreshCodexModels(config.cliPath ?? '', config.model).catch(() => undefined)
        }
      })
      .catch((error) =>
        setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setTesting(false))
  }

  return (
    <>
      <div className="set-pane-head">
        <h3 className="set-pane-title">{t('setSecAiModel')}</h3>
        <div className="set-pane-actions">
          <AiStatusPill
            status={
              testing
                ? { kind: 'testing', text: t('setAiTesting') }
                : testResult
                  ? testResult.ok
                    ? { kind: 'ok', text: t('setAiTestOk') }
                    : { kind: 'err', text: testResult.error || t('setAiTestFail') }
                  : saved
                    ? { kind: 'ok', text: t('setAiSaved') }
                    : null
            }
          />
          <button className="set-btn" disabled={testing} onClick={test}>
            {t('setAiTest')}
          </button>
          <button className="set-btn primary" disabled={!dirty} onClick={save}>
            {t('setAiSave')}
          </button>
        </div>
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label">{t('setAiProvider')}</label>
        </div>
        <Dropdown
          className="set-dd"
          value={provider}
          ariaLabel={t('setAiProvider')}
          options={catalog.map((c) => ({
            value: c.id,
            label: c.label,
            render: (
              <>
                <ProviderLogo id={c.id} />
                {c.label}
              </>
            ),
          }))}
          onPick={(v) => selectProvider(v as AiSettings['provider'])}
        />
      </div>
      <div className="set-field-desc set-ai-note">
        <ProviderNote provider={provider} t={t} />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label">{t('setAiModelId')}</label>
        </div>
        {!manualModel && meta && meta.models.length > 0 ? (
          <Dropdown
            className="set-dd"
            value={config.model || meta.defaultModel}
            ariaLabel={t('setAiModelId')}
            options={meta.models.map((m) => ({ value: m, label: m }))}
            onPick={(m) => updateConfig({ model: m })}
          />
        ) : (
          <input
            id="set-ai-model"
            className="set-input"
            type="text"
            value={config.model}
            placeholder="model-id"
            spellCheck={false}
            onChange={(e) => updateConfig({ model: e.target.value })}
          />
        )}
      </div>
      {!isCodex && !isGenspark && !isAgy && (
        <div className="set-field-desc set-model-discovery" aria-live="polite">
          <span>
            {modelListState === 'loading'
              ? t('setAiModelsLoading')
              : modelListState === 'live'
                ? t('setAiModelsLive', { n: modelListCount })
                : modelListState === 'fallback'
                  ? t('setAiModelsFallback')
                  : t('setAiModelsHint')}
          </span>
          <button
            className="set-btn"
            type="button"
            disabled={modelListState === 'loading'}
            onClick={() => setModelRefresh((value) => value + 1)}
          >
            {t('setAiModelsRefresh')}
          </button>
          {meta && meta.models.length > 0 && (
            <button
              className="set-btn"
              type="button"
              onClick={() => setManualModel((value) => !value)}
            >
              {manualModel ? t('setAiModelsChoose') : t('setAiModelsManual')}
            </button>
          )}
        </div>
      )}
      {isCodex ? (
        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-stack">
              <label className="set-field-label" htmlFor="set-ai-cli-path">
                {t('setAiCodexPath')}
              </label>
              <div className="set-field-desc">{t('setAiCodexPathHint')}</div>
            </div>
          </div>
          <input
            id="set-ai-cli-path"
            className="set-input"
            type="text"
            value={config.cliPath ?? ''}
            placeholder={t('setAiCodexAutoPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => updateConfig({ cliPath: e.target.value.trim() })}
            onBlur={(e) => {
              const cliPath = e.target.value.trim()
              void refreshCodexModels(cliPath, config.model).catch(() => undefined)
            }}
          />
        </div>
      ) : isAgy ? (
        <>
          <AgyProviderFields config={config} update={updateConfig} setCatalog={setCatalog} />
          <AgyChatModelsSettings />
        </>
      ) : !isGenspark ? (
        <>
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <label className="set-field-label" htmlFor="set-ai-key">
                  {t('setAiApiKey')}
                </label>
                <div className="set-field-desc">{t('setAiKeyHint')}</div>
              </div>
            </div>
            <input
              id="set-ai-key"
              className="set-input"
              type="password"
              value={config.apiKey}
              placeholder={meta?.keyPlaceholder ?? 'API Key'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => updateConfig({ apiKey: e.target.value.trim() })}
            />
          </div>
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <label className="set-field-label" htmlFor="set-ai-base-url">
                  {t('setAiBaseUrl')}
                </label>
                {!meta?.needsBaseUrl && (
                  <div className="set-field-desc">{t('setAiBaseUrlHint')}</div>
                )}
              </div>
            </div>
            <input
              id="set-ai-base-url"
              className="set-input"
              type="text"
              value={config.baseUrl ?? ''}
              placeholder={meta?.needsBaseUrl ? 'https://…/v1' : meta?.defaultBaseUrl}
              spellCheck={false}
              onChange={(e) => updateConfig({ baseUrl: e.target.value.trim() })}
            />
          </div>
        </>
      ) : null}
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-max-tokens">
              {t('setAiMaxTokens')}
            </label>
            <div className="set-field-desc">{t('setAiMaxTokensDesc')}</div>
          </div>
        </div>
        <input
          id="set-ai-max-tokens"
          className="set-input"
          type="number"
          min={MIN_MAX_OUTPUT_TOKENS}
          max={MAX_MAX_OUTPUT_TOKENS}
          step={1024}
          value={maxTokensDraft ?? String(settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)}
          onChange={(e) => setMaxTokensDraft(e.target.value)}
          onBlur={commitMaxTokens}
        />
      </div>
    </>
  )
}

type Capability = 'image' | 'analysis' | 'video' | 'search'
/** a tested block: the four capabilities plus the Jev reranker of the local file search */
type TestedBlock = Capability | 'rerank'
/** where an outside entry point (e.g. the home list's Jev button) lands when it opens the modal */
export interface SettingsTarget {
  section: SectionId
  block?: TestedBlock
}
type TestResult = { ok: boolean; error?: string }

const JEV_ENDPOINTS: { value: JevEndpoint; label: string }[] = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'direct', label: 'TypeSafe' },
]

/**
 * AI media & search pane, one block per capability — web search, image
 * generation, image analysis, video analysis — each with the same
 * provider / model / key / base URL rows as the AI Model pane. A vendor's key
 * and base URL are stored once and shared by every block that picks it.
 * Saved into the same ai-settings.json as the chat provider.
 */
function AiMediaPane({
  t,
  onFileSearchChange,
  focusBlock,
}: {
  t: TFunc
  onFileSearchChange?: () => void
  focusBlock?: TestedBlock
}) {
  const { lang } = useI18n()
  const [mediaCatalog] = useState<AiMediaProviderMeta[]>(() =>
    (window.aiOffice.getAiMediaProviders?.() ?? []).filter((entry) => entry.id !== 'genspark'),
  )
  const [searchCatalog] = useState<AiSearchProviderMeta[]>(
    () => window.aiOffice.getAiSearchProviders?.() ?? [],
  )
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [fileSearch, setFileSearchState] = useState<FileSearchSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<Partial<Record<TestedBlock, TestResult>> | null>(
    null,
  )
  const focused = useRef(false)
  const scrollToFocused = (el: HTMLDivElement | null) => {
    if (!el || focused.current) return
    focused.current = true
    el.scrollIntoView({ block: 'start' })
  }

  useEffect(() => {
    let alive = true
    void window.aiOffice.getAiSettings?.().then((s) => {
      if (alive && s) setSettings(s)
    })
    void window.aiOffice.getFileSearchSettings?.().then((v) => {
      if (alive && v) setFileSearchState(v)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!settings?.media || !settings.search) return null
  const media: AiMediaSettings = settings.media
  const search: AiSearchSettings = settings.search

  const touch = () => {
    setDirty(true)
    setSaved(false)
    setTestResults(null)
  }
  const setMedia = (next: AiMediaSettings) => {
    setSettings({ ...settings, media: next })
    touch()
  }
  const setSearch = (next: AiSearchSettings) => {
    setSettings({ ...settings, search: next })
    touch()
  }
  const setFileSearch = (next: FileSearchSettings) => {
    setFileSearchState(next)
    touch()
  }
  const mediaConfigOf = (id: AiMediaProviderId) => {
    const meta = mediaCatalog.find((m) => m.id === id)
    return (
      media.providers[id] ?? {
        apiKey: '',
        imageModel: meta?.defaultImageModel ?? '',
        analysisModel: meta?.defaultAnalysisModel ?? '',
      }
    )
  }
  const updateMediaConfig = (
    id: AiMediaProviderId,
    patch: Partial<AiMediaSettings['providers'][AiMediaProviderId]>,
  ) =>
    setMedia({
      ...media,
      providers: { ...media.providers, [id]: { ...mediaConfigOf(id), ...patch } },
    })

  const save = () => {
    Promise.all([
      window.aiOffice.setAiSettings?.(settings),
      fileSearch ? window.aiOffice.setFileSearchSettings?.(fileSearch) : undefined,
    ])
      .then(() => {
        setDirty(false)
        setSaved(true)
        onFileSearchChange?.()
      })
      .catch((error) => {
        appNotify(error instanceof Error ? error.message : String(error), 'error')
      })
  }
  // every block reports its own verdict; blocks sharing a vendor share that vendor's one check
  const test = async () => {
    setTesting(true)
    setTestResults(null)
    const results: Partial<Record<TestedBlock, TestResult>> = {}
    const fallback: TestResult = { ok: true }
    const vendorChecks = new Map<AiMediaProviderId, Promise<TestResult>>()
    const vendorCheck = (id: AiMediaProviderId) => {
      let pending = vendorChecks.get(id)
      if (!pending) {
        pending =
          window.aiOffice.testAiMediaSettings?.({
            provider: id,
            config: agyMediaTestConfig(id, mediaConfigOf(id), settings.providers.agy?.cliPath),
          }) ?? Promise.resolve(fallback)
        vendorChecks.set(id, pending)
      }
      return pending
    }
    const blocks: [TestedBlock, () => Promise<TestResult>][] = [
      [
        'search',
        () =>
          window.aiOffice.testAiSearchSettings?.({
            provider: search.provider,
            ...(search.provider === 'agy'
              ? { cliPath: settings.providers.agy?.cliPath, model: settings.providers.agy?.model }
              : {}),
            apiKey:
              search.provider === 'genspark'
                ? ''
                : (search.providers[search.provider]?.apiKey ?? ''),
          }) ?? Promise.resolve(fallback),
      ],
      ['image', () => vendorCheck(media.imageProvider)],
      ['analysis', () => vendorCheck(media.analysisProvider)],
      ['video', () => vendorCheck(media.videoAnalysisProvider)],
    ]
    if (fileSearch?.rerank) {
      blocks.push([
        'rerank',
        () =>
          window.aiOffice.testFileSearchRerank?.({
            endpoint: fileSearch.jevEndpoint,
            apiKey: fileSearch.jevKeys[fileSearch.jevEndpoint],
          }) ?? Promise.resolve(fallback),
      ])
    }
    await Promise.all(
      blocks.map(async ([block, run]) => {
        try {
          results[block] = await run()
        } catch (error) {
          results[block] = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
    setTestResults(results)
    setTesting(false)
  }

  const blockLabel = (block: TestedBlock) =>
    block === 'search'
      ? t('setAiCapSearch')
      : block === 'image'
        ? t('setAiCapImage')
        : block === 'analysis'
          ? t('setAiCapAnalysis')
          : block === 'video'
            ? t('setAiCapVideo')
            : t('setAiCapFileSearch')
  const blockProvider = (block: TestedBlock) => {
    if (block === 'rerank')
      return JEV_ENDPOINTS.find((e) => e.value === fileSearch?.jevEndpoint)?.label ?? ''
    if (block === 'search')
      return searchCatalog.find((m) => m.id === search.provider)?.label ?? search.provider
    const id =
      block === 'image'
        ? media.imageProvider
        : block === 'video'
          ? media.videoAnalysisProvider
          : media.analysisProvider
    return mediaCatalog.find((m) => m.id === id)?.label ?? id
  }
  const blockStatus = (block: TestedBlock): AiStatus | null => {
    if (testing) return { kind: 'testing', text: t('setAiTesting') }
    const r = testResults?.[block]
    if (!r) return null
    return r.ok
      ? { kind: 'ok', text: t('setAiTestOk') }
      : { kind: 'err', text: r.error || t('setAiTestFail') }
  }
  const subhead = (block: TestedBlock, title: string) => (
    <div className="set-pane-subhead" ref={block === focusBlock ? scrollToFocused : undefined}>
      <h4 className="set-pane-subtitle">{title}</h4>
      <AiStatusPill status={blockStatus(block)} />
    </div>
  )
  const failed = testResults
    ? (Object.keys(testResults) as TestedBlock[]).filter((b) => !testResults[b]?.ok)
    : []
  const headStatus: AiStatus | null = testing
    ? { kind: 'testing', text: t('setAiTesting') }
    : testResults
      ? failed.length === 0
        ? { kind: 'ok', text: t('setAiTestOk') }
        : {
            kind: 'err',
            text: `${blockLabel(failed[0]!)} · ${blockProvider(failed[0]!)}: ${testResults[failed[0]!]?.error || t('setAiTestFail')}`,
          }
      : saved
        ? { kind: 'ok', text: t('setAiSaved') }
        : null

  const providerRow = (
    label: string,
    value: string,
    options: { id: string; label: string }[],
    onPick: (id: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <label className="set-field-label">{t('setAiProvider')}</label>
      </div>
      <Dropdown
        className="set-dd"
        value={value}
        ariaLabel={label}
        options={options.map((c) => ({
          value: c.id,
          label: c.label,
          render: (
            <>
              <ProviderLogo id={c.id} />
              {c.label}
            </>
          ),
        }))}
        onPick={onPick}
      />
    </div>
  )

  const modelRow = (
    id: string,
    models: string[],
    fallback: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <label className="set-field-label" htmlFor={id}>
          {t('setAiModelId')}
        </label>
      </div>
      {models.length > 0 ? (
        <Dropdown
          className="set-dd"
          value={value || fallback}
          ariaLabel={t('setAiModelId')}
          options={models.map((m) => ({ value: m, label: m }))}
          onPick={onChange}
        />
      ) : (
        <input
          id={id}
          className="set-input"
          type="text"
          value={value}
          placeholder="model-id"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )

  const keyRow = (
    id: string,
    value: string,
    placeholder: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t('setAiApiKey')}
          </label>
          <div className="set-field-desc">{t('setAiKeyHint')}</div>
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="password"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  )

  const baseUrlRow = (
    id: string,
    meta: AiMediaProviderMeta,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t('setAiBaseUrl')}
          </label>
          {!meta.needsBaseUrl && <div className="set-field-desc">{t('setAiBaseUrlHint')}</div>}
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="text"
        value={value}
        placeholder={meta.needsBaseUrl ? 'https://…/v1' : meta.defaultBaseUrl}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  )

  /** one media block: provider → model → key → base URL (key/base URL shared per vendor) */
  const mediaBlock = (cap: Exclude<Capability, 'search'>) => {
    const title =
      cap === 'image'
        ? t('setAiCapImage')
        : cap === 'analysis'
          ? t('setAiCapAnalysis')
          : t('setAiCapVideo')
    const options = mediaCatalog.filter((m) =>
      cap === 'image'
        ? !!m.imageProtocol
        : cap === 'video'
          ? !!m.analysisProtocol && m.videoAnalysis
          : !!m.analysisProtocol,
    )
    const current =
      cap === 'image'
        ? media.imageProvider
        : cap === 'video'
          ? media.videoAnalysisProvider
          : media.analysisProvider
    const meta = options.find((m) => m.id === current) ?? options[0]!
    const id = meta.id
    const config = mediaConfigOf(id)
    const pick = (next: string) => {
      const p = next as AiMediaProviderId
      setMedia(
        cap === 'image'
          ? { ...media, imageProvider: p }
          : cap === 'video'
            ? { ...media, videoAnalysisProvider: p }
            : { ...media, analysisProvider: p },
      )
    }
    const modelField = cap === 'image' ? 'imageModel' : 'analysisModel'
    return (
      <section key={cap}>
        {subhead(cap, title)}
        {providerRow(title, id, options, pick)}
        <div className="set-field-desc set-ai-note">
          {id === 'genspark' ? t('setAiMediaGensparkHint') : meta.description}
        </div>
        {id === 'agy' && (
          <AgyMediaFields
            idPrefix={`set-ai-${cap}`}
            modelField={modelField}
            config={config}
            seedModels={cap === 'image' ? meta.imageModels : meta.analysisModels}
            defaultModel={cap === 'image' ? meta.defaultImageModel : meta.defaultAnalysisModel}
            chatCliPath={settings.providers.agy?.cliPath}
            update={(patch) => updateMediaConfig(id, patch)}
          />
        )}
        {id !== 'genspark' && id !== 'agy' && (
          <>
            {modelRow(
              `set-ai-${cap}-model`,
              cap === 'image' ? meta.imageModels : meta.analysisModels,
              cap === 'image' ? meta.defaultImageModel : meta.defaultAnalysisModel,
              config[modelField],
              (m) => updateMediaConfig(id, { [modelField]: m }),
            )}
            {keyRow(`set-ai-${cap}-key`, config.apiKey, meta.keyPlaceholder, (v) =>
              updateMediaConfig(id, { apiKey: v }),
            )}
            {baseUrlRow(`set-ai-${cap}-base-url`, meta, config.baseUrl ?? '', (v) =>
              updateMediaConfig(id, { baseUrl: v }),
            )}
          </>
        )}
      </section>
    )
  }

  const searchMeta = searchCatalog.find((m) => m.id === search.provider)
  const searchKey =
    search.provider === 'genspark' ? '' : (search.providers[search.provider]?.apiKey ?? '')

  return (
    <>
      <div className="set-pane-head">
        <h3 className="set-pane-title">{t('setSecAiMedia')}</h3>
        <div className="set-pane-actions">
          <AiStatusPill status={headStatus} />
          <button className="set-btn" disabled={testing} onClick={() => void test()}>
            {t('setAiTest')}
          </button>
          <button className="set-btn primary" disabled={!dirty} onClick={save}>
            {t('setAiSave')}
          </button>
        </div>
      </div>
      <div className="set-field-desc set-ai-note">{t('setAiSharedKeyHint')}</div>
      <section>
        {subhead('search', t('setAiCapSearch'))}
        {providerRow(t('setAiCapSearch'), search.provider, searchCatalog, (v) =>
          setSearch({ ...search, provider: v as AiSearchSettings['provider'] }),
        )}
        <div className="set-field-desc set-ai-note">
          {search.provider === 'agy'
            ? agyString(lang, 'agySearchNote')
            : search.provider === 'genspark'
              ? t('setAiSearchGensparkHint')
              : search.provider === 'parallel'
                ? t('setAiSearchParallelHint')
                : search.provider === 'serply'
                  ? t('setAiSearchSerplyHint')
                  : searchMeta?.imageSearch
                    ? t('setAiSearchSerperHint')
                    : t('setAiSearchTavilyHint')}
        </div>
        {search.provider !== 'genspark' &&
          search.provider !== 'agy' &&
          keyRow('set-ai-search-key', searchKey, searchMeta?.keyPlaceholder ?? 'API Key', (v) =>
            setSearch({
              ...search,
              providers: { ...search.providers, [search.provider]: { apiKey: v } },
            }),
          )}
      </section>
      {fileSearch && (
        <section>
          {subhead('rerank', t('setAiCapFileSearch'))}
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{t('setSearchRerank')}</div>
                <div className="set-field-desc">{t('setSearchRerankDesc')}</div>
              </div>
            </div>
            <button
              className="set-switch"
              role="switch"
              aria-checked={fileSearch.rerank}
              aria-label={t('setSearchRerank')}
              onClick={() => setFileSearch({ ...fileSearch, rerank: !fileSearch.rerank })}
            />
          </div>
          {fileSearch.rerank && (
            <>
              <div className="set-field">
                <div className="set-field-text">
                  <label className="set-field-label">{t('setSearchRerankEndpoint')}</label>
                </div>
                <Dropdown
                  className="set-dd"
                  value={fileSearch.jevEndpoint}
                  ariaLabel={t('setSearchRerankEndpoint')}
                  options={JEV_ENDPOINTS}
                  onPick={(v) =>
                    setFileSearch({
                      ...fileSearch,
                      jevEndpoint: v === 'direct' ? 'direct' : 'openrouter',
                    })
                  }
                />
              </div>
              {keyRow(
                'set-search-jev-key',
                fileSearch.jevKeys[fileSearch.jevEndpoint],
                fileSearch.jevEndpoint === 'openrouter' ? 'sk-or-…' : 'API Key',
                (v) =>
                  setFileSearch({
                    ...fileSearch,
                    jevKeys: { ...fileSearch.jevKeys, [fileSearch.jevEndpoint]: v },
                  }),
              )}
            </>
          )}
        </section>
      )}
      {mediaBlock('image')}
      {mediaBlock('analysis')}
      {mediaBlock('video')}
    </>
  )
}

interface AiStatus {
  kind: 'testing' | 'ok' | 'err'
  text: string
}

/** colored feedback pill in the AI pane header: spinner while testing, then success/error */
function AiStatusPill({ status }: { status: AiStatus | null }) {
  if (!status) return null
  return (
    <span
      className={`set-ai-status ${status.kind}`}
      role="status"
      // error text (HTTP body, network message) can be long — full text via native tooltip
      title={status.kind === 'err' ? status.text : undefined}
    >
      {status.kind === 'testing' ? (
        <span className="set-ai-spin" aria-hidden="true" />
      ) : status.kind === 'ok' ? (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path
            d="M4.2 7.3l1.9 1.9 3.7-4.3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ) : (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path d="M7 3.8v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="1" fill="currentColor" />
        </svg>
      )}
      <span className="set-ai-status-text">{status.text}</span>
    </span>
  )
}

export interface SettingsModalProps {
  onClose: () => void
  /** the Jev search settings were saved; the home search re-judges or drops its current order */
  onFileSearchChange?: () => void
  /** an installed skill is older than the bundled one: dot on the Integrations entry */
  skillUpdateDue?: boolean
  onSkillUpdateDue?: (due: boolean) => void
  /** open on this section / block instead of the general page */
  target?: SettingsTarget | null
}

export function SettingsModal({
  onClose,
  onFileSearchChange,
  skillUpdateDue: updateDue = false,
  onSkillUpdateDue,
  target,
}: SettingsModalProps) {
  const { lang, setLang, t } = useI18n()
  const [section, setSection] = useState<SectionId>(target?.section ?? 'general')
  const [theme, setTheme] = useState<UiTheme>('system')
  const [saveDir, setSaveDir] = useState('')
  const [analyticsOn, setAnalyticsOn] = useState(true)
  const [analyticsSaving, setAnalyticsSaving] = useState(false)
  const [autoSaveOn, setAutoSaveOn] = useState(false)
  const [defaultApp, setDefaultApp] = useState<DefaultAppStatus | null>(null)
  const [defaultAppBusy, setDefaultAppBusy] = useState(false)
  const [defaultAppFailed, setDefaultAppFailed] = useState(false)
  const [aiPrefs, setAiPrefs] = useState<AiPanelPrefs>(DEFAULT_AI_PANEL_PREFS)
  const [updateSource, setUpdateSource] = useState<UpdateSource>({
    kind: 'github',
    value: 'HThanh-how/genoffice',
  })
  const [savedUpdateSource, setSavedUpdateSource] = useState('github:HThanh-how/genoffice')
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateSaving, setUpdateSaving] = useState(false)
  const [updateNotice, setUpdateNotice] = useState('')
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable')
  const [legacyDoc, setLegacyDoc] = useState<LegacyDocSettings>({
    mode: 'online',
    endpoint: 'https://d2x.clouds.io.vn',
    convertOnOpen: true,
    convertInIndex: 'all',
  })
  const [legacyRecovery, setLegacyRecovery] = useState<LegacyRecoveryEntry[]>([])
  const [legacyRecoveryBusy, setLegacyRecoveryBusy] = useState<string | null>(null)
  const [legacyRecoveryError, setLegacyRecoveryError] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [githubStars, setGithubStars] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getTheme?.().then((th) => {
      if (alive) setTheme(th)
    })
    void window.aiOffice.getDefaultSaveDir?.().then((dir) => {
      if (alive && dir) setSaveDir(dir)
    })
    void window.aiOffice.getAnalyticsEnabled?.().then((on) => {
      if (alive) setAnalyticsOn(on !== false)
    })
    void window.aiOffice.getAutoSaveDefault?.().then((v) => {
      if (alive) setAutoSaveOn(v.on)
    })
    void window.aiOffice.getDefaultAppStatus?.().then((st) => {
      if (alive) setDefaultApp(st)
    })
    void window.aiOffice.getAiPanelPrefs?.().then((prefs) => {
      if (alive) setAiPrefs(prefs)
    })
    void window.aiOffice
      .getUpdateSource?.()
      .then((source) => {
        if (alive) {
          setUpdateSource(source)
          setSavedUpdateSource(`${source.kind}:${source.value}`)
        }
      })
      .catch(() => {
        if (alive) setUpdateNotice('—')
      })
    void window.aiOffice.getUpdateChannel?.().then((ch) => {
      if (alive) setChannel(ch)
    })
    void window.aiOffice.getLegacyDocSettings?.().then((value) => {
      if (alive) setLegacyDoc(value)
    })
    void window.aiOffice
      .listLegacyRecovery?.()
      .then((entries) => {
        if (alive) setLegacyRecovery(entries)
      })
      .catch(() => {})
    void window.aiOffice.getAppVersion?.().then((v) => {
      if (alive && v) setAppVersion(v)
    })
    void window.aiOffice.githubStars?.().then((n) => {
      if (alive && n !== null) setGithubStars(n)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const applyTheme = (next: UiTheme) => {
    setTheme(next)
    void window.aiOffice.setTheme(next)
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  }

  const updateLegacyDoc = (patch: Partial<LegacyDocSettings>) => {
    const next = { ...legacyDoc, ...patch }
    setLegacyDoc(next)
    void window.aiOffice.setLegacyDocSettings(next).then(setLegacyDoc)
  }

  const restoreOriginal = (id: string) => {
    setLegacyRecoveryBusy(id)
    setLegacyRecoveryError('')
    void window.aiOffice
      .restoreLegacyDoc(id)
      .then(() => window.aiOffice.listLegacyRecovery())
      .then(setLegacyRecovery)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setLegacyRecoveryError(
          lang === 'vi' && message.includes('already exists')
            ? 'Đã có tệp cùng tên ở vị trí cũ. Hãy đổi tên tệp đó trước khi khôi phục.'
            : message,
        )
      })
      .finally(() => setLegacyRecoveryBusy(null))
  }

  const updateAiPrefs = (patch: Partial<AiPanelPrefs>) => {
    setAiPrefs((prev) => ({ ...prev, ...patch }))
    void window.aiOffice.setAiPanelPrefs(patch).then(setAiPrefs)
  }

  const changeSaveDir = () => {
    void window.aiOffice.pickDefaultSaveDir?.().then((dir) => {
      if (dir) setSaveDir(dir)
    })
  }

  // Windows only opens the system page; re-read ownership when the user comes back
  useEffect(() => {
    if (!defaultApp?.manualOnly) return
    const refresh = () => {
      void window.aiOffice.getDefaultAppStatus?.().then(setDefaultApp)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [defaultApp?.manualOnly])

  const claimDefaultApp = () => {
    setDefaultAppBusy(true)
    setDefaultAppFailed(false)
    void window.aiOffice
      .setDefaultApp()
      .then((st) => {
        setDefaultApp(st)
        if (!st.manualOnly && st.state !== 'default') setDefaultAppFailed(true)
      })
      .catch(() => setDefaultAppFailed(true))
      .finally(() => setDefaultAppBusy(false))
  }

  const defaultAppDesc = (() => {
    if (!defaultApp) return ''
    if (defaultAppFailed) return t('setDefaultAppFailed')
    if (defaultApp.state === 'default') return t('setDefaultAppIs')
    if (defaultApp.state === 'other' && defaultApp.others.length > 0)
      return t('setDefaultAppOther', { app: defaultApp.others.join(', ') })
    return t('setDefaultAppDesc')
  })()

  return (
    <div
      className="set-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="set-dialog" role="dialog" aria-modal="true" aria-label={t('settings')}>
        <div className="set-header">
          <h2 className="set-title">{t('settings')}</h2>
          <button className="set-close" onClick={onClose} aria-label={t('cancel')}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav" aria-label={t('settings')}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`set-nav-item${section === s.id ? ' active' : ''}`}
                aria-current={section === s.id ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                <SectionIcon id={s.id} />
                {t(s.labelKey)}
                {s.id === 'integrations' && updateDue && (
                  <span className="set-nav-dot" role="img" aria-label={t('intgUpdateDue')} />
                )}
              </button>
            ))}
          </nav>
          <div className="set-pane" key={section}>
            {section === 'aiModel' && <AiModelPane t={t} />}
            {section === 'aiMedia' && (
              <AiMediaPane
                t={t}
                onFileSearchChange={onFileSearchChange}
                focusBlock={target?.block}
              />
            )}
            {section === 'general' && (
              <>
                <h3 className="set-pane-title">{t('setSecGeneral')}</h3>
                <SetGroup
                  title={groupText(lang, 'appearance')}
                  hint={groupHint(lang, 'appearance')}
                  icon="appearance"
                >
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('language')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={lang}
                      ariaLabel={t('language')}
                      options={LANG_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                      onPick={(v) => setLang(v as typeof lang)}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('theme')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={theme}
                      ariaLabel={t('theme')}
                      options={THEME_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: t(opt.labelKey),
                      }))}
                      onPick={(v) => applyTheme(v as UiTheme)}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('setAiPanelSide')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={aiPrefs.side}
                      ariaLabel={t('setAiPanelSide')}
                      options={[
                        { value: 'left', label: t('aiPanelSideLeft') },
                        { value: 'right', label: t('aiPanelSideRight') },
                      ]}
                      onPick={(side) => updateAiPrefs({ side: side as AiPanelSide })}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('setAiFontSize')}</label>
                    </div>
                    {aiPrefs.fontSize === 'custom' && (
                      <CustomFontSizeInput
                        value={aiPrefs.customFontSize}
                        label={t('aiFontSizeCustom')}
                        onCommit={(px) => updateAiPrefs({ customFontSize: px })}
                      />
                    )}
                    <Dropdown
                      className="set-dd"
                      value={aiPrefs.fontSize}
                      ariaLabel={t('setAiFontSize')}
                      options={AI_FONT_SIZE_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: t(opt.labelKey),
                      }))}
                      onPick={(v) => {
                        const fontSize = v as AiFontSize
                        // start the custom size from the preset being left so nothing jumps
                        updateAiPrefs(
                          fontSize === 'custom' && aiPrefs.fontSize !== 'custom'
                            ? { fontSize, customFontSize: aiPanelFontPx(aiPrefs) }
                            : { fontSize },
                        )
                      }}
                    />
                  </div>
                </SetGroup>
                <SetGroup
                  title={aiInstructionsTitle(lang).title}
                  hint={aiInstructionsTitle(lang).hint}
                >
                  <AiInstructionsSettings lang={lang} />
                </SetGroup>
                <SetGroup title={groupText(lang, 'ai')} hint={groupHint(lang, 'ai')} icon="ai">
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAiSpellcheck')}</div>
                        <div className="set-field-desc">{t('setAiSpellcheckDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={aiPrefs.spellcheck}
                      aria-label={t('setAiSpellcheck')}
                      onClick={() => updateAiPrefs({ spellcheck: !aiPrefs.spellcheck })}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAiOpenInNewDocs')}</div>
                        <div className="set-field-desc">{t('setAiOpenInNewDocsDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={aiPrefs.openInNewDocs}
                      aria-label={t('setAiOpenInNewDocs')}
                      onClick={() => updateAiPrefs({ openInNewDocs: !aiPrefs.openInNewDocs })}
                    />
                  </div>
                </SetGroup>
                <SetGroup
                  title={groupText(lang, 'files')}
                  hint={groupHint(lang, 'files')}
                  icon="files"
                >
                  {defaultApp && defaultApp.state !== 'unsupported' && (
                    <div className="set-field">
                      <div className="set-field-text">
                        <div className="set-field-stack">
                          <div className="set-field-label">{t('setDefaultApp')}</div>
                          <div className="set-field-desc">{defaultAppDesc}</div>
                        </div>
                      </div>
                      <button
                        className="set-btn"
                        disabled={defaultAppBusy || defaultApp.state === 'default'}
                        onClick={claimDefaultApp}
                      >
                        {defaultApp.manualOnly
                          ? t('setDefaultAppOpenSettings')
                          : t('setDefaultAppSet')}
                      </button>
                    </div>
                  )}
                  <Field
                    label={t('saveLocation')}
                    value={saveDir || '—'}
                    valueTitle={saveDir}
                    action={
                      <button className="set-btn" onClick={changeSaveDir}>
                        {t('setChange')}
                      </button>
                    }
                  />
                  <DefaultFolderToggle />
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAutoSave')}</div>
                        <div className="set-field-desc">{t('setAutoSaveDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={autoSaveOn}
                      aria-label={t('setAutoSave')}
                      onClick={() => {
                        const next = !autoSaveOn
                        setAutoSaveOn(next)
                        void window.aiOffice.setAutoSaveDefault?.(next).catch(() => {})
                      }}
                    />
                  </div>
                </SetGroup>
                <SetGroup
                  title={groupText(lang, 'legacy')}
                  icon="legacy"
                  hint={groupText(lang, 'legacyHint')}
                  fold
                >
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">Legacy Office files (.doc, .ppt)</div>
                        <div className="set-field-desc">
                          {legacyDoc.mode === 'text'
                            ? 'Keep files on this device. .doc opens locally (text-only on Windows and Linux). .ppt needs the conversion service and will not open in this mode.'
                            : legacyDoc.mode === 'online'
                              ? 'Convert automatically. macOS tries its built-in converter for .doc; .ppt and other .doc files are sent to the service below.'
                              : 'Ask before sending .doc or .ppt. macOS tries its built-in converter for .doc first.'}
                        </div>
                      </div>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={legacyDoc.mode}
                      ariaLabel="Legacy Office conversion and upload preference"
                      options={[
                        { value: 'ask', label: 'Ask before upload' },
                        { value: 'online', label: 'Convert automatically' },
                        { value: 'text', label: 'On-device only' },
                      ]}
                      onPick={(mode) =>
                        updateLegacyDoc({ mode: mode as LegacyDocSettings['mode'] })
                      }
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">
                          {lang === 'vi'
                            ? 'Mở tệp cũ thì chuyển sang định dạng mới'
                            : 'Convert old files to the new format when opened'}
                        </div>
                        <div className="set-field-desc">
                          {lang === 'vi'
                            ? 'Mở .xls thì dịch vụ chuyển đổi tạo tệp .xlsx giữ nguyên định dạng cạnh bản gốc rồi mở tệp mới; bản gốc được cất vào thư mục khôi phục ẩn 30 ngày. Tắt đi thì .xls mở như bản sao tạm và hỏi nơi lưu khi lưu.'
                            : 'Opening an .xls has the conversion service make an .xlsx (formatting intact) beside it and opens that; the original is kept in a hidden recovery folder for 30 days. Off: the .xls opens as a temporary copy and Save asks where to put it.'}
                        </div>
                      </div>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={legacyDoc.convertOnOpen ? 'on' : 'off'}
                      ariaLabel="Convert old files when opened"
                      options={[
                        { value: 'on', label: lang === 'vi' ? 'Bật' : 'On' },
                        { value: 'off', label: lang === 'vi' ? 'Tắt' : 'Off' },
                      ]}
                      onPick={(value) => updateLegacyDoc({ convertOnOpen: value === 'on' })}
                    />
                  </div>
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">
                          {lang === 'vi'
                            ? 'Chuyển tệp cũ trong chỉ mục sang định dạng mới'
                            : 'Convert old files in the index to the new format'}
                        </div>
                        <div className="set-field-desc">
                          {lang === 'vi'
                            ? 'Chạy nền, từng tệp một, tạm dừng khi máy dùng pin yếu. Cả .doc, .xls và .ppt đều do dịch vụ chuyển đổi làm, máy này không tự chuyển. Cần chế độ chuyển tự động. Bản gốc luôn được giữ 30 ngày.'
                            : 'Runs in the background, one file at a time, and pauses on a low battery. .doc, .xls and .ppt are all converted by the conversion service; this computer converts nothing. Needs automatic conversion. Originals are always kept for 30 days.'}
                        </div>
                      </div>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={legacyDoc.convertInIndex}
                      ariaLabel="Convert old files in the index"
                      options={[
                        { value: 'off', label: lang === 'vi' ? 'Tắt' : 'Off' },
                        {
                          value: 'all',
                          label:
                            lang === 'vi'
                              ? 'Bật (qua dịch vụ chuyển đổi)'
                              : 'On (through the conversion service)',
                        },
                      ]}
                      onPick={(value) =>
                        updateLegacyDoc({
                          convertInIndex: value as LegacyDocSettings['convertInIndex'],
                        })
                      }
                    />
                  </div>
                  {legacyDoc.mode !== 'text' && (
                    <div className="set-field">
                      <div className="set-field-text">
                        <div className="set-field-stack">
                          <label className="set-field-label" htmlFor="set-legacy-doc-endpoint">
                            Conversion service
                          </label>
                          <div className="set-field-desc">
                            Online conversion sends the entire file over HTTPS. The default public
                            service deletes temporary files after conversion; it does not verify
                            that requests come from GenOffice. You can use your own HTTPS service.
                          </div>
                        </div>
                      </div>
                      <input
                        id="set-legacy-doc-endpoint"
                        className="set-input"
                        type="url"
                        value={legacyDoc.endpoint}
                        onChange={(event) =>
                          setLegacyDoc({ ...legacyDoc, endpoint: event.target.value })
                        }
                        onBlur={() => updateLegacyDoc({ endpoint: legacyDoc.endpoint.trim() })}
                      />
                    </div>
                  )}
                  <div className="set-field set-legacy-recovery">
                    <div className="set-field-stack">
                      <div className="set-field-label">
                        {lang === 'vi' ? 'Khôi phục tệp .doc gốc' : 'Recover original .doc files'}
                      </div>
                      <div className="set-field-desc">
                        {lang === 'vi'
                          ? 'Sau khi chuyển giữ nguyên định dạng, tệp .doc gốc được cất trong thư mục .genoffice ẩn cạnh tài liệu trong 30 ngày. Bản chuyển chỉ lấy được chữ sẽ giữ nguyên tệp gốc.'
                          : 'After a formatted conversion, the original .doc is kept for 30 days in a hidden .genoffice folder beside the document. Text-only imports leave the original in place.'}
                      </div>
                      {legacyRecovery.length === 0 ? (
                        <div className="set-field-desc">
                          {lang === 'vi'
                            ? 'Chưa có tệp gốc nào cần khôi phục.'
                            : 'No originals are waiting for recovery.'}
                        </div>
                      ) : (
                        <div className="set-legacy-recovery-list">
                          {legacyRecovery.map((entry) => (
                            <div className="set-legacy-recovery-item" key={entry.id}>
                              <div className="set-legacy-recovery-info">
                                <strong>{entry.sourcePath.split(/[\\/]/).pop()}</strong>
                                <span title={entry.sourcePath}>{entry.sourcePath}</span>
                                <small>
                                  {lang === 'vi' ? 'Tự xóa: ' : 'Expires: '}
                                  {new Date(entry.expiresAt).toLocaleDateString()}
                                </small>
                              </div>
                              <button
                                className="set-btn"
                                disabled={legacyRecoveryBusy !== null}
                                onClick={() => restoreOriginal(entry.id)}
                              >
                                {legacyRecoveryBusy === entry.id
                                  ? lang === 'vi'
                                    ? 'Đang khôi phục…'
                                    : 'Restoring…'
                                  : lang === 'vi'
                                    ? 'Khôi phục'
                                    : 'Restore'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {legacyRecoveryError && (
                        <div className="set-field-desc set-legacy-recovery-error" role="alert">
                          {legacyRecoveryError}
                        </div>
                      )}
                    </div>
                  </div>
                </SetGroup>
                <SetGroup
                  title={groupText(lang, 'opening')}
                  icon="opening"
                  hint={groupText(lang, 'openingHint')}
                  fold
                >
                  <OpeningEffectsSettings lang={lang} />
                </SetGroup>
                <SetGroup
                  title={groupText(lang, 'privacy')}
                  hint={groupHint(lang, 'privacy')}
                  icon="privacy"
                >
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setAnalytics')}</div>
                        <div className="set-field-desc">{t('setAnalyticsDesc')}</div>
                      </div>
                    </div>
                    <button
                      className="set-switch"
                      role="switch"
                      aria-checked={analyticsOn}
                      aria-label={t('setAnalytics')}
                      disabled={analyticsSaving}
                      onClick={() => {
                        const next = !analyticsOn
                        setAnalyticsSaving(true)
                        void window.aiOffice
                          .setAnalyticsEnabled(next)
                          .then((persisted) => {
                            if (persisted) setAnalyticsOn(next)
                          })
                          .catch(() => {})
                          .finally(() => setAnalyticsSaving(false))
                      }}
                    />
                  </div>
                  <ClipboardSettingsToggle />
                  <ClipboardHistorySettings />
                </SetGroup>
                <DocumentMemorySettings />
              </>
            )}
            {section === 'integrations' && (
              <IntegrationsPane t={t} onStatus={(st) => onSkillUpdateDue?.(skillUpdateDue(st))} />
            )}
            {section === 'about' && (
              <>
                <h3 className="set-pane-title">{t('setSecAbout')}</h3>
                <SetGroup
                  title={lang === 'vi' ? 'Ứng dụng & cập nhật' : 'Application & updates'}
                  icon="files"
                >
                  <Field
                    label={t('versionLabel')}
                    value={appVersion || '—'}
                    action={
                      <button
                        className="set-btn"
                        disabled={
                          updateBusy ||
                          updateSaving ||
                          `${updateSource.kind}:${updateSource.value}` !== savedUpdateSource
                        }
                        onClick={() => {
                          setUpdateBusy(true)
                          setUpdateNotice('')
                          void window.aiOffice
                            .checkForUpdates()
                            .catch(() => setUpdateNotice(t('updateSourceError')))
                            .finally(() => setUpdateBusy(false))
                        }}
                      >
                        {t(updateBusy ? 'updateChecking' : 'updateNow')}
                      </button>
                    }
                  />
                  <div className="set-field">
                    <label className="set-field-label">{t('updateSourceLabel')}</label>
                    <Dropdown
                      className="set-dd"
                      value={updateSource.kind}
                      ariaLabel={t('updateSourceLabel')}
                      options={[
                        { value: 'github', label: 'GitHub' },
                        { value: 'manifest', label: 'HTTPS JSON' },
                      ]}
                      onPick={(kind) => {
                        setUpdateNotice('')
                        setUpdateSource({
                          kind: kind === 'manifest' ? 'manifest' : 'github',
                          value: kind === 'manifest' ? '' : 'HThanh-how/genoffice',
                        })
                      }}
                    />
                  </div>
                  <div className="set-field">
                    <input
                      className="set-input"
                      aria-label={t('updateSourceLabel')}
                      value={updateSource.value}
                      placeholder={
                        updateSource.kind === 'github'
                          ? 'HThanh-how/genoffice'
                          : 'https://example.com/updates.json'
                      }
                      disabled={updateBusy || updateSaving}
                      onChange={(event) => {
                        setUpdateNotice('')
                        setUpdateSource({ ...updateSource, value: event.target.value })
                      }}
                    />
                    <button
                      className="set-btn"
                      disabled={updateSaving || updateBusy || !updateSource.value.trim()}
                      onClick={() => {
                        setUpdateSaving(true)
                        setUpdateNotice('')
                        void window.aiOffice
                          .setUpdateSource(updateSource)
                          .then((source) => {
                            setUpdateSource(source)
                            setSavedUpdateSource(`${source.kind}:${source.value}`)
                            setUpdateNotice(t('setAiSaved'))
                          })
                          .catch(() => setUpdateNotice(t('updateSourceError')))
                          .finally(() => setUpdateSaving(false))
                      }}
                    >
                      {t('setAiSave')}
                    </button>
                  </div>
                  <p className="set-field-desc" role="status">
                    {updateNotice || t('updateSourceHint')}
                  </p>
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('updateChannel')}</label>
                    </div>
                    <Dropdown
                      className="set-dd"
                      value={channel}
                      ariaLabel={t('updateChannel')}
                      options={CHANNEL_OPTIONS.map((opt) => ({
                        value: opt.value,
                        label: t(opt.labelKey),
                      }))}
                      onPick={(v) => {
                        const next = v === 'beta' ? 'beta' : 'stable'
                        setChannel(next)
                        void window.aiOffice.setUpdateChannel(next)
                      }}
                    />
                  </div>
                  <Field
                    label={t('setGithub')}
                    value={
                      githubStars === null
                        ? 'github.com/HThanh-how/genoffice'
                        : `github.com/HThanh-how/genoffice · ★ ${formatStars(githubStars)}`
                    }
                    action={
                      <button
                        className="set-btn"
                        onClick={() => void window.aiOffice.openGitHubRepo?.()}
                      >
                        {t('starOnGitHub')}
                      </button>
                    }
                  />
                </SetGroup>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
