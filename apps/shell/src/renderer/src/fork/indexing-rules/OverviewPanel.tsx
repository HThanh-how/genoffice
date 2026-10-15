import { useState } from 'react'
import type {
  IgnoreRule,
  IndexPolicyMode,
  IndexingPreset,
} from '../../../../shared/fork/document-index-api'
import type { StudioStrings } from './studio-strings'
import { PresetsPanel } from './PresetsPanel'
import { PathTester } from './PathTester'
import { IconChevronDown, IconChevronUp, IconFile, IconLayers, IconShield } from './studio-icons'
import type { HomeApi } from '../../../../shared/home-api'

/* Mirrors KNOWN_DOCUMENT_EXTENSIONS / KNOWN_MEDIA_EXTENSIONS in ignore-policy.ts. */
const DOCUMENT_GROUPS = [
  { label: 'PDF', exts: ['.pdf'] },
  { label: 'Word', exts: ['.doc', '.docx'] },
  { label: 'Excel', exts: ['.xls', '.xlsx', '.xlsm'] },
  { label: 'PowerPoint', exts: ['.ppt', '.pptx'] },
  { label: 'Text & Markdown', exts: ['.txt', '.md', '.markdown'] },
  { label: 'HTML', exts: ['.html', '.htm'] },
  { label: 'CSV & TSV', exts: ['.csv', '.tsv'] },
]

export interface OverviewPanelProps {
  strings: StudioStrings
  api: HomeApi
  mode: IndexPolicyMode
  presets: IndexingPreset[]
  customRules: IgnoreRule[]
  fileRuleCount: number
  roots: string[]
  fileExists: Record<string, boolean>
  saving: boolean
  onModeChange: (mode: IndexPolicyMode) => void
  onPresetToggle: (presetId: string, enabled: boolean) => void
  onOpenRules: () => void
  onOpenEditor: (root: string) => void
}

export function OverviewPanel(props: OverviewPanelProps) {
  const {
    strings: d,
    api,
    mode,
    presets,
    customRules,
    fileRuleCount,
    roots,
    fileExists,
    saving,
  } = props
  const [presetsOpen, setPresetsOpen] = useState(false)

  const enabledPresets = presets.filter((preset) => preset.enabled !== false).length
  const allowCount = customRules.filter((rule) => rule.action === 'allow').length
  const ignoreCount = customRules.filter((rule) => rule.action !== 'allow').length

  return (
    <div className="ixr-card ixr-overview">
      <section className="ixr-section">
        <h4>{d.modeLabel}</h4>
        <div className="ixr-segmented" role="radiogroup" aria-label={d.modeLabel}>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'standard'}
            className={mode === 'standard' ? 'active' : ''}
            onClick={() => props.onModeChange('standard')}
          >
            <IconLayers />
            <span>{d.modeStandard}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'allowlist'}
            className={mode === 'allowlist' ? 'active' : ''}
            onClick={() => props.onModeChange('allowlist')}
          >
            <IconShield />
            <span>{d.modeAllowlist}</span>
          </button>
        </div>
        <p className="ixr-hint">
          {mode === 'standard' ? d.modeStandardDesc : d.modeAllowlistDesc}
          {saving && <span className="ixr-saving">{d.saving}</span>}
        </p>
      </section>

      <section className="ixr-section">
        <h4>{d.docTypesTitle}</h4>
        <div className="ixr-type-groups">
          {DOCUMENT_GROUPS.map((group) => (
            <div key={group.label} className="ixr-type-group">
              <strong>{group.label}</strong>
              <span>{group.exts.join(', ')}</span>
            </div>
          ))}
        </div>
        <p className="ixr-hint">{d.mediaHint}</p>
      </section>

      <section className="ixr-section">
        <h4>{d.presetsTitle}</h4>
        <p className="ixr-hint">{d.presetsSummary(enabledPresets, presets.length)}</p>
        <button
          type="button"
          className="ixr-disclose"
          aria-expanded={presetsOpen}
          onClick={() => setPresetsOpen((open) => !open)}
        >
          <span>{d.presetsManage}</span>
          {presetsOpen ? <IconChevronUp /> : <IconChevronDown />}
        </button>
        {presetsOpen && (
          <PresetsPanel
            strings={d}
            presets={presets}
            busy={saving}
            onToggle={props.onPresetToggle}
          />
        )}
      </section>

      <section className="ixr-section">
        <h4>{d.customTitle}</h4>
        <p className="ixr-hint">{d.customSummary(allowCount, ignoreCount, fileRuleCount)}</p>
        <button type="button" className="ixr-btn" onClick={props.onOpenRules}>
          <span>{d.viewRules}</span>
        </button>
      </section>

      <section className="ixr-section">
        <h4>{d.configTitle}</h4>
        {roots.length === 0 ? (
          <p className="ixr-hint">{d.emptyAllRules}</p>
        ) : (
          <ul className="ixr-file-list">
            {roots.map((root) => (
              <li key={root} className="ixr-file-row">
                <IconFile />
                <span className="ixr-file-path">{root}</span>
                <span className={fileExists[root] ? 'ixr-file-ok' : 'ixr-file-none'}>
                  {fileExists[root] ? d.fileExists : d.fileMissing}
                </span>
                <button type="button" className="ixr-btn" onClick={() => props.onOpenEditor(root)}>
                  <span>{d.editFile}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ixr-section">
        <h4>{d.testerTitle}</h4>
        <PathTester strings={d} api={api} roots={roots} />
      </section>
    </div>
  )
}
