import { useEffect, useState } from 'react'
import { useI18n } from '../locale'
import { clipboardString } from './clipboard-strings'

/** Settings -> General row that opts in to clipboard suggestions (off by default). */
export function ClipboardSettingsToggle() {
  const { lang } = useI18n()
  const [on, setOn] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getClipboardSuggestEnabled?.().then((enabled) => {
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
          <div className="set-field-label">{clipboardString(lang, 'clipSetting')}</div>
          <div className="set-field-desc">{clipboardString(lang, 'clipSettingDesc')}</div>
        </div>
      </div>
      <button
        className="set-switch"
        role="switch"
        aria-checked={on}
        aria-label={clipboardString(lang, 'clipSetting')}
        disabled={saving}
        onClick={() => {
          const next = !on
          setSaving(true)
          void window.aiOffice
            .setClipboardSuggestEnabled(next)
            .then((persisted) => {
              if (persisted) setOn(next)
            })
            .catch(() => {})
            .finally(() => setSaving(false))
        }}
      />
    </div>
  )
}
