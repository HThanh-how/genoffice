import { Dropdown } from '@genoffice/ui'
import { isRepresentableColumnName } from '@genoffice/docx-engine'
import { BIG, TabProps } from '../ribbon-tabs'
import { IconCaret, IconHighlight, IconSearch, IconTable } from '../icons'
import { useI18n } from '../../i18n/locale'
import type { MailMergeSource } from '../../mail-merge/types'
import { selectedCount } from '../../mail-merge/recipient-store'

export interface MailingsTabProps extends TabProps {
  source: MailMergeSource | null
  previewOn: boolean
  previewIndex: number
  highlight: boolean
  onOpenPicker: (kind?: 'csv' | 'xlsx' | 'sheets') => void
  onTogglePreview: (on: boolean) => void
  onStepPreview: (delta: number) => void
  onToggleHighlight: (on: boolean) => void
  onInsertField: (name: string) => void
  onCheckErrors: () => void
  onExport: (format: 'docx' | 'pdf') => void
}

export function MailingsTab({
  hasDoc,
  source,
  previewOn,
  previewIndex,
  highlight,
  onOpenPicker,
  onTogglePreview,
  onStepPreview,
  onToggleHighlight,
  onInsertField,
  onCheckErrors,
  onExport,
}: MailingsTabProps) {
  const { t: tr } = useI18n()
  // the batch runs over the ticked rows or over every row, depending on the
  // scope chosen in the export dialog — a source with rows is enough to start
  const ready = hasDoc && source !== null && source.recipients.length > 0
  const whyNotReady = !source ? tr('mailMergeTipNoSource') : tr('mailMergeTipNoneSelected')

  return (
    <div className="ribbon-body-inner">
      <div className="ribbon-group">
        <div className="ribbon-group-items">
          <button
            className="rb-big"
            disabled={!hasDoc}
            data-tip={tr('mailMergeTipStart')}
            onClick={() => onOpenPicker()}
          >
            <span className="rb-big-icon">
              <IconTable size={BIG} />
            </span>
            <span>{tr('mailMergeStart')}</span>
          </button>
          <Dropdown
            value="recipients"
            disabled={!hasDoc}
            tip={tr('mailMergeTipSelectRecipients')}
            ariaLabel={tr('mailMergeSelectRecipients')}
            options={[
              { value: 'csv', label: tr('mailMergeFromCsv') },
              { value: 'xlsx', label: tr('mailMergeFromExcel') },
              { value: 'sheets', label: tr('mailMergeFromSheets') },
            ]}
            onPick={(value) => onOpenPicker(value as 'csv' | 'xlsx' | 'sheets')}
          />
          <button
            className="rb-big"
            disabled={!source}
            data-tip={source ? tr('mailMergeTipEditList') : whyNotReady}
            onClick={() => onOpenPicker()}
          >
            <span className="rb-big-icon">
              <IconTable size={BIG} />
            </span>
            <span>{tr('mailMergeEditList')}</span>
          </button>
        </div>
        <div className="ribbon-group-label">{tr('mailMergeGroupStart')}</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-items">
          <Dropdown
            value="insert-field"
            disabled={!ready}
            tip={ready ? tr('mailMergeTipInsertField') : whyNotReady}
            ariaLabel={tr('mailMergeInsertField')}
            options={
              ready
                ? [
                    { value: 'insert-field', label: tr('mailMergeInsertField'), disabled: true },
                    ...source!.columns.map((column) => ({
                      value: column.name,
                      label: column.name,
                      // a header with a double quote cannot be a MERGEFIELD name;
                      // offering it would insert a field for a different column
                      disabled: !isRepresentableColumnName(column.name),
                    })),
                  ]
                : [{ value: 'insert-field', label: tr('mailMergeNoColumns'), disabled: true }]
            }
            onPick={(value) => {
              if (value !== 'insert-field') onInsertField(value)
            }}
          />
          <button
            className={`rb-big ${highlight ? 'active' : ''}`}
            disabled={!ready}
            data-tip={ready ? tr('mailMergeTipHighlight') : whyNotReady}
            onClick={() => onToggleHighlight(!highlight)}
          >
            <span className="rb-big-icon">
              <IconHighlight size={BIG} />
            </span>
            <span>{tr('mailMergeHighlight')}</span>
          </button>
        </div>
        <div className="ribbon-group-label">{tr('mailMergeGroupFields')}</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-items">
          <button
            className={`rb-big ${previewOn ? 'active' : ''}`}
            disabled={!ready}
            data-tip={ready ? tr('mailMergeTipPreview') : whyNotReady}
            onClick={() => onTogglePreview(!previewOn)}
          >
            <span className="rb-big-icon">
              <IconSearch size={BIG} />
            </span>
            <span>{tr('mailMergePreview')}</span>
          </button>
          <div className="mm-preview-nav">
            <button
              className="rb-icon"
              disabled={!ready || !previewOn}
              data-tip={tr('mailMergeTipPrev')}
              aria-label={tr('mailMergePrev')}
              onClick={() => onStepPreview(-1)}
            >
              <span className="mm-caret mm-caret-left">
                <IconCaret />
              </span>
            </button>
            <span className="mm-preview-count" aria-live="polite">
              {previewOn && source ? `${previewIndex + 1} / ${selectedCount(source)}` : '—'}
            </span>
            <button
              className="rb-icon"
              disabled={!ready || !previewOn}
              data-tip={tr('mailMergeTipNext')}
              aria-label={tr('mailMergeNext')}
              onClick={() => onStepPreview(1)}
            >
              <IconCaret />
            </button>
          </div>
        </div>
        <div className="ribbon-group-label">{tr('mailMergeGroupPreview')}</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-items">
          <button
            className="rb-big"
            disabled={!ready}
            data-tip={ready ? tr('mailMergeTipCheckErrors') : whyNotReady}
            onClick={onCheckErrors}
          >
            <span className="rb-big-icon">
              <IconSearch size={BIG} />
            </span>
            <span>{tr('mailMergeCheckErrors')}</span>
          </button>
          <Dropdown
            value="finish"
            disabled={!ready}
            tip={ready ? tr('mailMergeTipFinish') : whyNotReady}
            ariaLabel={tr('mailMergeFinish')}
            options={[
              { value: 'docx', label: tr('mailMergeExportDocx') },
              { value: 'pdf', label: tr('mailMergeExportPdf') },
            ]}
            onPick={(value) => onExport(value as 'docx' | 'pdf')}
          />
        </div>
        <div className="ribbon-group-label">{tr('mailMergeGroupFinish')}</div>
      </div>
    </div>
  )
}
