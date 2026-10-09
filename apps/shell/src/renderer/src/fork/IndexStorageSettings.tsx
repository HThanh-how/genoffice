import { useCallback, useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type {
  StorageBudgetConfig,
  StorageBudgetPreset,
  StorageBudgetSnapshot,
} from '../../../shared/fork/document-index-api'
import {
  QUOTA_MAX_BYTES,
  QUOTA_MIN_BYTES,
  QUOTA_PRESET_BYTES,
  estimateDocumentCapacity,
  formatQuotaBytes,
  isQuotaInRange,
  recommendQuotaPreset,
  type QuotaPresetKey,
} from '../../../shared/fork/storage-estimate'
import { useI18n } from '../locale'
import { runIndexMutation } from './index-mutation'
import { quotaString, type QuotaStringKey } from './storage-quota-i18n'

const PRESETS: Array<{ preset: QuotaPresetKey; label: QuotaStringKey }> = [
  { preset: '1gb', label: 'presetSaver' },
  { preset: '3gb', label: 'presetDefault' },
  { preset: '5gb', label: 'presetHigh' },
]

const mb = (bytes: number): string => String(Math.round(bytes / 1_000_000))

/**
 * Index size: presets (Saver 1 GB / Default 3 GB / High 5 GB) or a custom size, what is used now, an ESTIMATE of how
 * many documents fit, and the grace-zone note. Saving goes through the live budget path (settings file -> worker ACK).
 */
export function IndexStorageSettings({ api }: { api: HomeApi }) {
  const { lang, dateLocale } = useI18n()
  const q = (key: QuotaStringKey, params?: Record<string, string | number>) => quotaString(lang, key, params)
  const [config, setConfig] = useState<StorageBudgetConfig | null>(null)
  const [snapshot, setSnapshot] = useState<StorageBudgetSnapshot | null>(null)
  const [selected, setSelected] = useState<StorageBudgetPreset>('3gb')
  const [customMb, setCustomMb] = useState('3000')
  const [dimensions, setDimensions] = useState<number | null>(null)
  const [recommended, setRecommended] = useState<QuotaPresetKey | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<QuotaStringKey | null>(null)
  const [errorText, setErrorText] = useState('')

  const refreshSnapshot = useCallback(async () => {
    if (typeof api.getDocumentIndexStorageBudget === 'function') {
      setSnapshot(await api.getDocumentIndexStorageBudget())
    }
  }, [api])

  const load = useCallback(async () => {
    try {
      if (typeof api.getStorageBudgetSettings === 'function') {
        const loaded = await api.getStorageBudgetSettings()
        setConfig(loaded)
        setSelected(loaded.preset)
        setCustomMb(mb(loaded.maxDatabaseBytes))
      }
      await refreshSnapshot()
      if (typeof api.getEmbeddingModel === 'function') {
        const model = await api.getEmbeddingModel()
        setDimensions(model.profiles?.[model.profile]?.dimensions ?? null)
        if (model.machine?.totalMemGiB) setRecommended(recommendQuotaPreset(model.machine.totalMemGiB))
      }
    } catch {
      // the panel still shows whatever loaded
    } finally {
      setLoading(false)
    }
  }, [api, refreshSnapshot])

  useEffect(() => {
    void load()
  }, [load])

  const apply = async (bytes: number, preset: StorageBudgetPreset) => {
    if (!isQuotaInRange(bytes)) {
      setNote('invalid')
      setErrorText('')
      return
    }
    setSaving(true)
    setNote(null)
    setErrorText('')
    try {
      if (typeof api.setStorageBudgetSettings === 'function') {
        const result = await runIndexMutation(() => api.setStorageBudgetSettings!({ maxDatabaseBytes: bytes, preset }))
        if (result?.settings) {
          setConfig(result.settings)
          setSelected(result.settings.preset)
          setCustomMb(mb(result.settings.maxDatabaseBytes))
          if (result.ok) setNote('saved')
          else if (result.settings.status === 'error') setErrorText(result.error ?? result.settings.error ?? q('invalid'))
          else setNote('savedPending')
        } else {
          setErrorText(result?.error ?? q('invalid'))
        }
        await refreshSnapshot()
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : q('invalid'))
    } finally {
      setSaving(false)
    }
  }

  const choosePreset = (preset: QuotaPresetKey) => {
    setSelected(preset)
    setCustomMb(mb(QUOTA_PRESET_BYTES[preset]))
    void apply(QUOTA_PRESET_BYTES[preset], preset)
  }

  if (loading && !config) return null

  const quota = snapshot?.softBudgetBytes ?? snapshot?.budgetBytes ?? config?.maxDatabaseBytes ?? 0
  const used = snapshot?.totalManagedBytes ?? snapshot?.databaseBytes ?? 0
  const pct = quota > 0 ? Math.round((used / quota) * 100) : 0
  const over = snapshot?.overQuotaBytes ?? Math.max(0, used - quota)
  const full = snapshot?.limitState === 'full'
  const graceActive = !full && (snapshot?.graceActive === true || over > 0)
  const targetBytes = config?.maxDatabaseBytes ?? quota
  const withVectors = estimateDocumentCapacity(targetBytes, dimensions ?? 320)
  const textOnly = estimateDocumentCapacity(targetBytes, 0)
  const number = (n: number) => n.toLocaleString(dateLocale)

  const applied =
    config?.status === 'applied' && typeof config.appliedVersion === 'number' && config.appliedVersion === config.version
  const failed = config?.status === 'error' || (Boolean(config?.error) && !applied)
  const chip = failed
    ? { cls: 'error', text: q('statusError', { error: config?.error ?? '' }) }
    : applied
      ? { cls: 'ok', text: q('statusApplied') }
      : { cls: '', text: q('statusPending') }

  return (
    <div className="ixq" data-testid="index-storage-settings">
      <div className="ixq-head">
        <p className="ixq-title">{q('title')}</p>
        {config && <span className={`ixq-chip ${chip.cls}`}>{chip.text}</span>}
      </div>
      <p className="ixq-text">{q('hint')}</p>

      <div className="ixq-presets" role="group" aria-label={q('title')}>
        {PRESETS.map(({ preset, label }) => (
          <button
            key={preset}
            type="button"
            className="ixq-preset"
            aria-pressed={selected === preset}
            disabled={saving}
            onClick={() => choosePreset(preset)}
          >
            <strong>{q(label)}</strong>
            <span>{formatQuotaBytes(QUOTA_PRESET_BYTES[preset], dateLocale)}</span>
            {preset === '1gb' && <small>{q('forRam')}</small>}
            {recommended === preset && <small>{q('recommended')}</small>}
          </button>
        ))}
        <button
          type="button"
          className="ixq-preset"
          aria-pressed={selected === 'custom'}
          disabled={saving}
          onClick={() => setSelected('custom')}
        >
          <strong>{q('presetCustom')}</strong>
        </button>
      </div>

      {selected === 'custom' && (
        <div className="ixq-custom">
          <label htmlFor="ixq-custom-mb">{q('customLabel')}</label>
          <input
            id="ixq-custom-mb"
            type="number"
            min={QUOTA_MIN_BYTES / 1_000_000}
            max={QUOTA_MAX_BYTES / 1_000_000}
            step={100}
            value={customMb}
            disabled={saving}
            onChange={(e) => setCustomMb(e.target.value)}
          />
          <button
            type="button"
            className="idx-btn"
            disabled={saving}
            onClick={() => void apply(Math.round(Number(customMb) * 1_000_000), 'custom')}
          >
            {q('save')}
          </button>
        </div>
      )}

      <div className="ixq-box">
        {quota > 0 && (
          <>
            <strong>{q('used', { used: formatQuotaBytes(used, dateLocale), quota: formatQuotaBytes(quota, dateLocale), pct })}</strong>
            <div className={`ixq-bar${over > 0 ? ' over' : ''}`} aria-hidden="true">
              <span style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </>
        )}
        <p>
          <strong>{q('estimate', { n: number(withVectors.documents) })}</strong>
          {' · '}
          {q('estimateLexical', { n: number(textOnly.documents) })}
        </p>
        <p>{q('estimateNote')}</p>
        <p>{q('grace')}</p>
        {snapshot?.nameMetadataReserveBytes !== undefined && (
          <p>{q('nameReserve', { used: snapshot.nameMetadataBytes === undefined ? '—' : formatQuotaBytes(snapshot.nameMetadataBytes, dateLocale), quota: formatQuotaBytes(snapshot.nameMetadataReserveBytes, dateLocale) })}</p>
        )}
        {snapshot?.nameMetadataBytes !== undefined && snapshot.nameMetadataReserveBytes !== undefined && snapshot.nameMetadataBytes >= snapshot.nameMetadataReserveBytes && <p className="ixq-alert full" role="alert">{q('nameFull')}</p>}
        <p>{q('lowerNote')}</p>
        {full && (
          <p className="ixq-alert full" role="alert">
            {q('full')}
          </p>
        )}
        {graceActive && (
          <p className="ixq-alert" role="status">
            {q('graceActive', { over: formatQuotaBytes(over, dateLocale) })}
          </p>
        )}
      </div>

      {(note || errorText) && (
        <p
          className={errorText || note === 'invalid' ? 'ixs-error' : 'idx-muted'}
          role={errorText || note === 'invalid' ? 'alert' : 'status'}
          style={{ margin: '8px 0 0', fontSize: '12px' }}
        >
          {errorText || (note ? q(note) : '')}
        </p>
      )}
    </div>
  )
}
