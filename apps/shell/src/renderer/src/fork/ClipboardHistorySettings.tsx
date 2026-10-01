import { useEffect, useState } from 'react'
import { clipboardHistoryLabels } from '@genoffice/electron-utils/clipboard-history-labels'
import { useI18n } from '../locale'

export function ClipboardHistorySettings() {
  const { lang } = useI18n()
  const labels = clipboardHistoryLabels(lang)
  const [on, setOn] = useState(false)
  const [saving, setSaving] = useState(false)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getClipboardHistoryEnabled?.().then((enabled) => {
      if (alive) setOn(enabled === true)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <div className="set-field-label">{labels.title}</div>
          <div className="set-field-desc">{labels.description}</div>
        </div>
      </div>
      <button
        className="set-switch"
        role="switch"
        aria-checked={on}
        aria-label={labels.title}
        disabled={saving}
        onClick={() => {
          const next = !on
          setSaving(true)
          void window.aiOffice
            .setClipboardHistoryEnabled?.(next)
            .then((persisted) => {
              if (persisted) setOn(next)
            })
            .catch(() => {})
            .finally(() => setSaving(false))
        }}
      />
      {on && (
        <button
          className="set-btn"
          disabled={saving}
          onClick={() => {
            setSaving(true)
            void window.aiOffice
              .clearClipboardHistory?.()
              .then((ok) => {
                if (ok) {
                  setCleared(true)
                  setTimeout(() => setCleared(false), 1500)
                }
              })
              .catch(() => {})
              .finally(() => setSaving(false))
          }}
        >
          {cleared ? labels.cleared : labels.clear}
        </button>
      )}
    </div>
  )
}
