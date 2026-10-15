import type { IndexingPreset } from '../../../../shared/fork/document-index-api'
import type { StudioStrings } from './studio-strings'

export interface PresetsPanelProps {
  strings: StudioStrings
  presets: IndexingPreset[]
  busy: boolean
  onToggle: (presetId: string, enabled: boolean) => void
}

export function PresetsPanel({ strings: d, presets, busy, onToggle }: PresetsPanelProps) {
  return (
    <ul className="ixr-preset-list">
      {presets.map((preset) => {
        const enabled = preset.enabled !== false
        return (
          <li key={preset.id} className="ixr-preset-row">
            <div className="ixr-preset-main">
              <strong>{preset.name}</strong>
              <span className="ixr-preset-desc">{preset.description}</span>
              <span className="ixr-preset-patterns">
                {preset.patterns.slice(0, 4).join(', ')}
                {preset.patterns.length > 4 ? ` +${preset.patterns.length - 4}` : ''}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${enabled ? d.disable : d.enable}: ${preset.name}`}
              className={`ixr-switch${enabled ? ' on' : ''}`}
              disabled={busy}
              onClick={() => onToggle(preset.id, !enabled)}
            >
              <span className="ixr-switch-knob" aria-hidden="true" />
              <span>{enabled ? d.stateEnabled : d.stateDisabled}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
