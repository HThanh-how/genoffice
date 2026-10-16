import { useState } from 'react'
import { useModalKeys } from '../modal-keys'
import { useI18n, type StringKey } from '../../i18n/locale'
import type {
  MailMergeExportOptions,
  MailMergeExportProgress,
  MailMergeSource,
  MailMergeValidationIssue,
} from '../../mail-merge/types'
import { selectedCount } from '../../mail-merge/recipient-store'
import { isFinished } from '../../mail-merge/progress'
import { validateFileNamePattern } from '../../mail-merge/validation'

export function MailMergeExportDialog({
  source,
  format,
  onClose,
  onStart,
}: {
  source: MailMergeSource
  format: 'docx' | 'pdf'
  onClose: () => void
  onStart: (options: MailMergeExportOptions) => void
}) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  const [scope, setScope] = useState<'selected' | 'all'>('selected')
  const [outputDir, setOutputDir] = useState('')
  // the grant the main process minted for this batch. Every write carries it, so
  // a batch that released the folder cannot land a file in it even if the user
  // picks the very same directory again afterwards.
  const [batch, setBatch] = useState('')
  // the default names follow the source's own first column: a literal `{Name}`
  // would be an unknown token for a source whose columns are "Full Name" and
  // "Postal Address", and an unknown token silently disappears from the file name
  const defaultPattern = source.columns[0] ? `{index}_{${source.columns[0].name}}` : '{index}'
  const [pattern, setPattern] = useState(defaultPattern)
  const [overwrite, setOverwrite] = useState<'skip' | 'rename' | 'overwrite'>('rename')

  const count = scope === 'selected' ? selectedCount(source) : source.recipients.length
  const knownColumns = source.columns.map((c) => c.name)
  // the same token grammar the export engine uses, so the dialog never accepts a
  // pattern that would silently lose a token on the way to the file name
  const patternCheck = validateFileNamePattern(pattern, knownColumns)
  const patternValid = patternCheck.valid

  return (
    <div
      className="modal-backdrop"
      ref={modalKeys.ref}
      onKeyDown={modalKeys.onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal mail-merge-export">
        <h2>{format === 'docx' ? t('mailMergeExportDocx') : t('mailMergeExportPdf')}</h2>
        <label>
          {t('mailMergeRecipients')}
          <select value={scope} onChange={(e) => setScope(e.target.value as 'selected' | 'all')}>
            <option value="selected">
              {t('mailMergeScopeSelected', { n: selectedCount(source) })}
            </option>
            <option value="all">{t('mailMergeScopeAll', { n: source.recipients.length })}</option>
          </select>
        </label>
        <label>
          {t('mailMergeOutputFolder')}
          <div className="mm-dir-row">
            <input value={outputDir} readOnly placeholder={t('mailMergePickFolder')} />
            <button
              className="btn-ghost"
              onClick={async () => {
                const picked = await window.desktop.pickMailMergeOutputDir()
                if (picked) {
                  setOutputDir(picked.dir)
                  setBatch(picked.batch ?? '')
                }
              }}
            >
              {t('mailMergeBrowse')}
            </button>
          </div>
        </label>
        <label>
          {t('mailMergeFileNamePattern')}
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="{index}_{Name}"
          />
          <span className="mm-pattern-hint">{t('mailMergePatternHint')}</span>
        </label>
        <label>
          {t('mailMergeOverwrite')}
          <select
            value={overwrite}
            onChange={(e) => setOverwrite(e.target.value as 'skip' | 'rename' | 'overwrite')}
          >
            <option value="rename">{t('mailMergeOverwriteRename')}</option>
            <option value="skip">{t('mailMergeOverwriteSkip')}</option>
            <option value="overwrite">{t('mailMergeOverwriteReplace')}</option>
          </select>
        </label>
        {!patternValid && (
          <p className="modal-error">
            {t('mailMergePatternInvalid')}
            {patternCheck.unknown.length > 0 ? `: {${patternCheck.unknown.join('}, {')}` : ''}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            {t('mailMergeCancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!outputDir || count === 0 || !patternValid}
            onClick={() =>
              onStart({ format, scope, outputDir, pattern, overwrite, combined: false, batch })
            }
          >
            {t('mailMergeStartExport', { n: count })}
          </button>
        </div>
      </div>
    </div>
  )
}

export function MailMergeProgressDialog({
  progress,
  onCancel,
  onClose,
}: {
  progress: MailMergeExportProgress
  onCancel: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  // the terminal status, not the counters: a job that throws before the first
  // recipient has done=0 and cancelled=false, so counting alone never ends
  const finished = isFinished(progress)
  const heading =
    progress.status === 'completed'
      ? t('mailMergeExportCompleted')
      : progress.status === 'completed_with_errors'
        ? t('mailMergeExportWithErrors')
        : progress.status === 'cancelled'
          ? t('mailMergeExportCancelled')
          : progress.status === 'failed'
            ? t('mailMergeExportFailed')
            : t('mailMergeExporting')
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div className="modal-backdrop" ref={modalKeys.ref} onKeyDown={modalKeys.onKeyDown}>
      <div className="modal mail-merge-progress">
        <h2>{heading}</h2>
        <p>{t('mailMergeProgressLine', { done: progress.done, total: progress.total, percent })}</p>
        <div
          className="mm-progress-bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="mm-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <ul className="mm-progress-counts">
          <li>{t('mailMergeSucceeded', { n: progress.succeeded })}</li>
          <li>{t('mailMergeFailed', { n: progress.failed })}</li>
          <li>{t('mailMergeSkipped', { n: progress.skipped })}</li>
        </ul>
        {!finished && progress.current && <p className="mm-current">{progress.current}</p>}
        {progress.errors.length > 0 && (
          <details className="mm-error-list">
            <summary>{t('mailMergeViewErrors', { n: progress.errors.length })}</summary>
            {progress.errors.slice(0, 50).map((error, i) => (
              <p key={i}>
                {error.recipient}: {error.message}
              </p>
            ))}
          </details>
        )}
        <div className="modal-actions">
          {!finished && (
            <button className="btn-ghost" onClick={onCancel}>
              {t('mailMergeCancel')}
            </button>
          )}
          <button className="btn-primary" onClick={onClose}>
            {finished ? t('mailMergeClose') : t('mailMergeCancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function MailMergeValidationDialog({
  issues,
  onClose,
  onContinue,
}: {
  issues: MailMergeValidationIssue[]
  onClose: () => void
  onContinue: () => void
}) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  const blocking = issues.filter((i) => i.severity === 'error')
  return (
    <div
      className="modal-backdrop"
      ref={modalKeys.ref}
      onKeyDown={modalKeys.onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal mail-merge-validation">
        <h2>{t('mailMergeValidationTitle')}</h2>
        {issues.length === 0 && <p>{t('mailMergeNoProblems')}</p>}
        <ul className="mm-issue-list">
          {issues.map((issue, i) => (
            <li key={i} className={`mm-issue ${issue.severity}`}>
              {t(issue.key as StringKey)}
              {issue.detail ? ` — ${issue.detail}` : ''}
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            {t('mailMergeCancel')}
          </button>
          <button className="btn-primary" disabled={blocking.length > 0} onClick={onContinue}>
            {t('mailMergeContinue')}
          </button>
        </div>
      </div>
    </div>
  )
}
