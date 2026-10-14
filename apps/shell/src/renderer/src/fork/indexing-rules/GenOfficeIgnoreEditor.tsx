import { useRef } from 'react'
import type { StudioStrings } from './studio-strings'
import { IconAlert, IconBook, IconFile, IconRefresh, IconSave } from './studio-icons'

const SYNTAX_LINES = [
  ['@mode standard', 'Default indexing mode for this folder.'],
  ['@mode allowlist', 'Restrict indexing to explicit allow patterns.'],
  ['!pattern', 'Explicit allow — takes priority over ignore rules.'],
  ['pattern', 'Explicit ignore — excludes matching paths.'],
  ['# comment', 'Ignored by the evaluator.'],
]

export interface GenOfficeIgnoreEditorProps {
  strings: StudioStrings
  roots: string[]
  root: string
  content: string
  original: string
  exists: boolean
  errors: string[]
  saving: boolean
  conflict: boolean
  syntaxOpen: boolean
  onSyntaxToggle: () => void
  onRootChange: (root: string) => void
  onContentChange: (content: string) => void
  onSave: () => void
  onReload: () => void
  onInsertTemplate: () => void
}

export function GenOfficeIgnoreEditor(props: GenOfficeIgnoreEditorProps) {
  const {
    strings: d,
    roots,
    root,
    content,
    original,
    exists,
    errors,
    saving,
    conflict,
    syntaxOpen,
    onSyntaxToggle,
    onRootChange,
    onContentChange,
    onSave,
    onReload,
    onInsertTemplate,
  } = props

  const gutterRef = useRef<HTMLDivElement>(null)
  const dirty = content !== original
  const lineCount = content.split('\n').length

  const syncGutter = (event: { currentTarget: HTMLTextAreaElement }) => {
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(-${event.currentTarget.scrollTop}px)`
    }
  }

  return (
    <div className="ixr-card ixr-editor">
      <div className="ixr-editor-toolbar">
        <label className="ixr-filter-field">
          <span>{d.editorRootLabel}</span>
          <select
            className="idx-input ixr-select"
            value={root}
            onChange={(event) => onRootChange(event.target.value)}
            aria-label={d.editorRootLabel}
          >
            {roots.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <span className={`ixr-file-status ${exists ? 'exists' : 'missing'}`}>
          <IconFile />
          <span>{exists ? d.fileExists : d.fileMissing}</span>
        </span>
        <div className="ixr-editor-actions">
          <button
            type="button"
            className="ixr-btn-primary"
            disabled={!dirty || saving}
            onClick={onSave}
          >
            <IconSave />
            <span>{saving ? d.saving : d.editorSave}</span>
          </button>
          <button type="button" className="ixr-btn" onClick={onReload}>
            <IconRefresh />
            <span>{d.editorReload}</span>
          </button>
          <button type="button" className="ixr-btn" onClick={onInsertTemplate}>
            <span>{d.editorTemplate}</span>
          </button>
          <button
            type="button"
            className="ixr-btn"
            aria-expanded={syntaxOpen}
            onClick={onSyntaxToggle}
          >
            <IconBook />
            <span>{d.editorSyntax}</span>
          </button>
        </div>
      </div>

      {conflict && (
        <div className="ixr-alert warning" role="alert">
          <IconAlert />
          <span>{d.editorConflict}</span>
        </div>
      )}

      {errors.length > 0 && (
        <ul className="ixr-error-list" role="alert">
          <li className="ixr-error-title">{d.editorErrorsTitle}</li>
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}

      {syntaxOpen && (
        <div className="ixr-syntax-guide">
          <h5>{d.syntaxTitle}</h5>
          <ul>
            {SYNTAX_LINES.map(([code, meaning]) => (
              <li key={code}>
                <code>{code}</code> — {meaning}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="ixr-editor-shell">
        <div className="ixr-editor-gutter" aria-hidden="true">
          <div ref={gutterRef} className="ixr-gutter-inner">
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index} className="ixr-line-no">
                {index + 1}
              </span>
            ))}
          </div>
        </div>
        <textarea
          className="ixr-editor-text"
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          onScroll={syncGutter}
          spellCheck={false}
          aria-label={d.editorTitle}
        />
      </div>

      <div className="ixr-editor-status" role="status">
        {saving ? (
          <span className="ixr-status-saving">{d.saving}</span>
        ) : dirty ? (
          <span className="ixr-status-dirty">{d.editorDirty}</span>
        ) : (
          <span className="ixr-status-clean">{exists ? d.editorClean : d.editorMissing}</span>
        )}
      </div>
    </div>
  )
}
