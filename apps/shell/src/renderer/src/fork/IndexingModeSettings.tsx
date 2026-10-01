import { useEffect, useState } from 'react'
import { useI18n } from '../locale'
import {
  INDEXING_MODES,
  type IndexingMode,
  type IndexingModeState,
} from '../../../shared/fork/indexing-mode'
import { indexingModeKeys, indexingString, indexingStateLine } from './indexing-mode-strings'
import './indexing-mode.css'

const POLL_MS = 3000

/** Document memory -> how hard background indexing may work, and what it is doing right now. */
export function IndexingModeSettings() {
  const { lang } = useI18n()
  const [state, setState] = useState<IndexingModeState | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (typeof window.aiOffice?.getIndexingModeState !== 'function') return
    let alive = true
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      void window.aiOffice
        .getIndexingModeState()
        .then((next) => {
          if (alive) setState(next)
        })
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  if (typeof window.aiOffice?.getIndexingModeState !== 'function') return null

  const change = (apply: () => Promise<boolean>, optimistic: Partial<IndexingModeState>) => {
    const previous = state
    setSaving(true)
    setState((current) => (current ? { ...current, ...optimistic } : current))
    void apply()
      .then((ok) => {
        if (!ok) setState(previous)
      })
      .catch(() => setState(previous))
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
            <label
              key={mode}
              className={`set-indexmode-card${selected ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="indexing-mode"
                value={mode}
                checked={selected}
                disabled={!state || saving}
                onChange={() =>
                  change(() => window.aiOffice.setIndexingMode(mode), { mode })
                }
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
          {effective
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
