import { useEffect, useState } from 'react'
import type { IgnoreRule, IndexRuleAction } from '../../../../shared/fork/document-index-api'
import type { StudioStrings } from './studio-strings'
import { IconX } from './studio-icons'

export interface RuleForm {
  action: IndexRuleAction
  pattern: string
  scope: string
  description: string
}

export interface RuleEditorModalProps {
  strings: StudioStrings
  open: boolean
  rule: IgnoreRule | null
  roots: string[]
  onClose: () => void
  onSubmit: (form: RuleForm) => void
}

export function RuleEditorModal({
  strings: d,
  open,
  rule,
  roots,
  onClose,
  onSubmit,
}: RuleEditorModalProps) {
  const [action, setAction] = useState<IndexRuleAction>(rule?.action ?? 'ignore')
  const [pattern, setPattern] = useState(rule?.pattern ?? '')
  const [scope, setScope] = useState(rule?.scope ?? 'global')
  const [description, setDescription] = useState(rule?.description ?? '')

  useEffect(() => {
    if (!open) return
    setAction(rule?.action ?? 'ignore')
    setPattern(rule?.pattern ?? '')
    setScope(rule?.scope ?? 'global')
    setDescription(rule?.description ?? '')
  }, [open, rule])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="ixr-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="ixr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={rule ? d.modalEditTitle : d.modalAddTitle}
      >
        <header className="ixr-modal-head">
          <h4>{rule ? d.modalEditTitle : d.modalAddTitle}</h4>
          <button type="button" className="ixr-icon-btn" aria-label={d.cancel} onClick={onClose}>
            <IconX />
          </button>
        </header>

        <form
          className="ixr-modal-form"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit({ action, pattern: pattern.trim(), scope, description: description.trim() })
          }}
        >
          <label className="ixr-field">
            <span>{d.actionLabel}</span>
            <select
              className="idx-input ixr-select"
              value={action}
              onChange={(event) => setAction(event.target.value as IndexRuleAction)}
            >
              <option value="ignore">{d.filterIgnore}</option>
              <option value="allow">{d.filterAllow}</option>
            </select>
          </label>
          <label className="ixr-field">
            <span>{d.patternLabel}</span>
            <input
              type="text"
              className="idx-input ixr-input"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder={d.patternPlaceholder}
              required
            />
          </label>
          <label className="ixr-field">
            <span>{d.scopeFieldLabel}</span>
            <select
              className="idx-input ixr-select"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="global">{d.scopeGlobalOption}</option>
              {roots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          </label>
          <label className="ixr-field">
            <span>{d.descLabel}</span>
            <input
              type="text"
              className="idx-input ixr-input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={d.descPlaceholder}
            />
          </label>

          <div className="ixr-modal-actions">
            <button type="button" className="ixr-btn" onClick={onClose}>
              <span>{d.cancel}</span>
            </button>
            <button type="submit" className="ixr-btn-primary" disabled={!pattern.trim()}>
              <span>{d.saveRule}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
