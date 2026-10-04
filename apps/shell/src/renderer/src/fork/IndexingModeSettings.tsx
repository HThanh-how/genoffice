import { useEffect, useState } from 'react'
import { useI18n } from '../locale'
import {
  INDEXING_MODES,
  type IndexingMode,
  type IndexingModeState,
} from '../../../shared/fork/indexing-mode'
import { indexingModeKeys, indexingString, indexingStateLine } from './indexing-mode-strings'
import { readIndexRequest } from './index-request'
import './indexing-mode.css'

const POLL_MS = 3000

/** Document memory -> how hard background indexing may work, and what it is doing right now. */
export function IndexingModeSettings() {
  const { lang } = useI18n()
  const [state, setState] = useState<IndexingModeState | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (typeof window.aiOffice?.getIndexingModeState !== 'function') return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        if (document.visibilityState === 'visible') {
          const next = await readIndexRequest(
            () => window.aiOffice.getIndexingModeState(),
            (value): value is IndexingModeState =>
              !!value &&
              typeof value === 'object' &&
              INDEXING_MODES.includes((value as IndexingModeState).mode),
          )
          if (alive) {
            setState(next)
            setFailed(false)
          }
        }
      } catch {
        if (alive) setFailed(true)
      } finally {
        if (alive) timer = setTimeout(() => void refresh(), POLL_MS)
      }
    }
    void refresh()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (typeof window.aiOffice?.getIndexingModeState !== 'function') return null

  const change = (apply: () => Promise<boolean>, optimistic: Partial<IndexingModeState>) => {
    const previous = state
    setSaving(true)
    setState((current) => (current ? { ...current, ...optimistic } : current))
    void readIndexRequest(apply, (value): value is boolean => typeof value === 'boolean')
      .then((ok) => {
        if (!ok) setState(previous)
      })
      .catch(() => {
        setState(previous)
        setFailed(true)
      })
      .finally(() => setSaving(false))
  }

  const effective = state?.effective ?? null
  const tone = !effective ? 'wait' : effective.paused ? 'paused' : effective.tier
  return (
    <div className="set-indexmode">
      <h4 className="set-field-label">{indexingString(lang, 'title')}</h4>
      <p className="set-field-desc">{indexingString(lang, 'desc')}</p>
      <div
        className="set-indexmode-cards"
        role="radiogroup"
        aria-label={indexingString(lang, 'modeLabel')}
      >
        {INDEXING_MODES.map((mode: IndexingMode) => {
          const keys = indexingModeKeys(mode)
          const selected = state?.mode === mode
          return (
            <label key={mode} className={`set-indexmode-card${selected ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="indexing-mode"
                value={mode}
                checked={selected}
                disabled={!state || saving}
                onChange={() => change(() => window.aiOffice.setIndexingMode(mode), { mode })}
              />
              <span className="set-indexmode-name">{indexingString(lang, keys.label)}</span>
              <span className="set-indexmode-desc">{indexingString(lang, keys.desc)}</span>
            </label>
          )
        })}
      </div>
      <div className="set-indexmode-status" data-tone={tone} role="status" aria-live="polite">
        <span className="set-indexmode-dot" aria-hidden="true" />
        <span>
          {failed
            ? lang === 'vi'
              ? 'Chưa xác nhận được trạng thái. Sẽ kiểm tra lại tự động.'
              : 'Status could not be confirmed. Retrying automatically.'
            : effective
              ? indexingStateLine(lang, effective)
              : indexingString(lang, 'statusChecking')}
        </span>
      </div>
      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{indexingString(lang, 'pauseBattery')}</div>
            <div className="set-field-desc">{indexingString(lang, 'pauseBatteryDesc')}</div>
          </div>
        </div>
        <button
          className="set-switch"
          type="button"
          role="switch"
          aria-checked={state?.pauseOnBattery ?? true}
          aria-label={indexingString(lang, 'pauseBattery')}
          disabled={!state || saving}
          onClick={() =>
            state &&
            change(() => window.aiOffice.setPauseIndexingOnBattery(!state.pauseOnBattery), {
              pauseOnBattery: !state.pauseOnBattery,
            })
          }
        />
      </div>
    </div>
  )
}
