import { useEffect, useMemo, useState } from 'react'
import { useModalKeys } from './modal-keys'
import { useI18n } from '../i18n/locale'
import {
  loadCsvSource,
  loadSheetSource,
  loadXlsxSource,
  listXlsxSheets,
} from '../mail-merge/data-source'
import { DEFAULT_FILTER, selectedCount, setSelected, visibleRecipients } from '../mail-merge/recipient-store'
import type { MailMergeFilter, MailMergeSource, MailMergeSourceKind } from '../mail-merge/types'

const PAGE_SIZE = 100

export function RecipientPickerDialog({
  source,
  preferredKind,
  onClose,
  onApply,
}: {
  source: MailMergeSource | null
  preferredKind?: MailMergeSourceKind
  onClose: () => void
  onApply: (source: MailMergeSource) => void
}) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  const [kind, setKind] = useState<MailMergeSourceKind>(preferredKind ?? source?.kind ?? 'csv')
  const [pending, setPending] = useState<MailMergeSource | null>(source)
  const [error, setError] = useState('')
  const [sheets, setSheets] = useState<string[]>([])
  const [sheet, setSheet] = useState('')
  const [hasHeader, setHasHeader] = useState(true)
  const [sheetTabs, setSheetTabs] = useState<Array<{ id: string; title: string }>>([])
  const [tabId, setTabId] = useState('')
  const [range, setRange] = useState('A1:F1000')
  const [filter, setFilter] = useState<MailMergeFilter>(DEFAULT_FILTER)
  const [page, setPage] = useState(0)

  useEffect(() => {
    if (kind === 'sheets') {
      void window.desktop.listSheetTabs().then((tabs) => {
        setSheetTabs(tabs)
        if (tabs[0]) setTabId(tabs[0].id)
      })
    }
  }, [kind])

  const [rawFile, setRawFile] = useState<{ base64: string; path: string } | null>(null)

  async function applyXlsx(base64: string, path: string, sheetName: string) {
    setRawFile({ base64, path })
    setPending(await loadXlsxSource(base64, path, sheetName, hasHeader))
    setPage(0)
  }

  async function pickFile() {
    const result = await window.desktop.pickMailMergeSource()
    if (!result) return
    if (!result.ok || !result.base64) {
      setError(result.error ?? t('mailMergeReadFailed'))
      return
    }
    try {
      if (kind === 'xlsx') {
        const names = await listXlsxSheets(result.base64)
        setSheets(names)
        const first = names[0] ?? ''
        setSheet(first)
        setPending(await loadXlsxSource(result.base64, result.path ?? '', first, hasHeader))
      } else {
        setPending(loadCsvSource(result.base64, result.path ?? '', hasHeader))
      }
      setError('')
      setPage(0)
    } catch (err) {
      setError(String(err))
    }
  }

  async function readOpenSheet() {
    if (!tabId) {
      setError(t('mailMergeNoSheetOpen'))
      return
    }
    try {
      const context = await window.desktop.readSheetGrid(Number(tabId))
      const names = (context.result as { context?: { sheets?: Array<{ name: string }> } } | undefined)?.context?.sheets
      const list = names?.map((s) => s.name) ?? []
      setSheets(list)
      const chosen = sheet || list[0] || ''
      setSheet(chosen)
      setPending(await loadSheetSource(Number(tabId), t('mailMergeOpenSpreadsheet'), chosen, range, hasHeader))
      setError('')
      setPage(0)
    } catch (err) {
      setError(String(err))
    }
  }

  const visible = useMemo(
    () => (pending ? visibleRecipients(pending, filter) : []),
    [pending, filter],
  )
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const rows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const selected = pending ? selectedCount(pending) : 0

  const toggleVisible = (value: boolean) => {
    if (!pending) return
    setPending(setSelected(pending, new Set(visible.map((r) => r.id)), value))
  }

  return (
    <div className="modal-backdrop" ref={modalKeys.ref} onKeyDown={modalKeys.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mail-merge-picker">
        <h2>{t('mailMergePickerTitle')}</h2>
        <div className="mm-source-tabs" role="tablist">
          {(['csv', 'xlsx', 'sheets'] as MailMergeSourceKind[]).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={kind === value}
              className={`mm-source-tab ${kind === value ? 'active' : ''}`}
              onClick={() => setKind(value)}
            >
              {value === 'csv' ? t('mailMergeFromCsv') : value === 'xlsx' ? t('mailMergeFromExcel') : t('mailMergeFromSheets')}
            </button>
          ))}
        </div>

        <div className="mm-source-controls">
          {kind === 'sheets' ? (
            <>
              <label>
                {t('mailMergeWorkbook')}
                <select value={tabId} onChange={(e) => setTabId(e.target.value)}>
                  {sheetTabs.length === 0 && <option value="">{t('mailMergeNoSheetOpen')}</option>}
                  {sheetTabs.map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('mailMergeWorksheet')}
                <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                  {sheets.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('mailMergeRange')}
                <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="A1:F1000" />
              </label>
              <button className="btn-ghost" onClick={() => void readOpenSheet()}>
                {t('mailMergeReadSheet')}
              </button>
            </>
          ) : (
            <>
              <button className="btn-ghost" onClick={() => void pickFile()}>
                {pending ? t('mailMergeChooseAnother') : t('mailMergeChooseFile')}
              </button>
              {kind === 'xlsx' && sheets.length > 1 && (
                <label>
                  {t('mailMergeWorksheet')}
                  <select
                    value={sheet}
                    onChange={(e) => {
                      setSheet(e.target.value)
                      if (rawFile) void applyXlsx(rawFile.base64, rawFile.path, e.target.value).catch((err) => setError(String(err)))
                    }}
                  >
                    {sheets.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          <label className="mm-header-toggle">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
            {t('mailMergeFirstRowHeader')}
          </label>
        </div>

        {pending && (
          <div className="mm-picker-meta">
            <span>
              {t('mailMergeSourceLabel', { source: pending.label, sheet: pending.sheet ?? '' })}
            </span>
            <span>
              {t('mailMergeRecipientCount', { n: pending.recipients.length, selected })}
            </span>
          </div>
        )}

        {error && <p className="modal-error">{error}</p>}

        {pending && (
          <>
            <div className="mm-picker-filters">
              <input
                type="search"
                value={filter.search}
                placeholder={t('mailMergeSearch')}
                aria-label={t('mailMergeSearch')}
                onChange={(e) => {
                  setFilter({ ...filter, search: e.target.value })
                  setPage(0)
                }}
              />
              <select
                value={filter.column}
                aria-label={t('mailMergeFilterColumn')}
                onChange={(e) => {
                  setFilter({ ...filter, column: e.target.value })
                  setPage(0)
                }}
              >
                <option value="">{t('mailMergeAnyColumn')}</option>
                {pending.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={filter.operator}
                aria-label={t('mailMergeFilterOperator')}
                onChange={(e) => setFilter({ ...filter, operator: e.target.value as MailMergeFilter['operator'] })}
              >
                <option value="contains">{t('mailMergeContains')}</option>
                <option value="equals">{t('mailMergeEquals')}</option>
                <option value="empty">{t('mailMergeIsEmpty')}</option>
                <option value="notempty">{t('mailMergeIsNotEmpty')}</option>
              </select>
              <input
                value={filter.value}
                placeholder={t('mailMergeFilterValue')}
                onChange={(e) => setFilter({ ...filter, value: e.target.value })}
              />
              <select
                value={filter.sortColumn}
                aria-label={t('mailMergeSortBy')}
                onChange={(e) => setFilter({ ...filter, sortColumn: e.target.value })}
              >
                <option value="">{t('mailMergeNoSort')}</option>
                {pending.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="btn-ghost" onClick={() => setFilter({ ...filter, sortDir: filter.sortDir === 'asc' ? 'desc' : 'asc' })}>
                {filter.sortDir === 'asc' ? t('mailMergeAscending') : t('mailMergeDescending')}
              </button>
            </div>

            <div className="mm-recipient-table" role="table">
              <div className="mm-recipient-head" role="row">
                <span role="columnheader">{t('mailMergeSelect')}</span>
                {pending.columns.map((c) => (
                  <span role="columnheader" key={c.name}>
                    {c.name}
                  </span>
                ))}
              </div>
              {rows.map((recipient) => (
                <div className="mm-recipient-row" role="row" key={recipient.id}>
                  <input
                    type="checkbox"
                    role="cell"
                    checked={recipient.selected}
                    aria-label={t('mailMergeSelectRecipient', { id: recipient.id + 1 })}
                    onChange={(e) => setPending(setSelected(pending, new Set([recipient.id]), e.target.checked))}
                  />
                  {pending.columns.map((c) => (
                    <span role="cell" key={c.name}>
                      {recipient.values[c.name] ?? ''}
                    </span>
                  ))}
                </div>
              ))}
              {rows.length === 0 && <p className="mm-empty">{t('mailMergeNoRows')}</p>}
            </div>

            {pageCount > 1 && (
              <div className="mm-pagination">
                <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  {t('mailMergePrevPage')}
                </button>
                <span>
                  {page + 1} / {pageCount}
                </span>
                <button className="btn-ghost" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>
                  {t('mailMergeNextPage')}
                </button>
                <span className="mm-visible-count">
                  {t('mailMergeVisibleCount', { n: visible.length })}
                </span>
              </div>
            )}

            <div className="mm-picker-actions">
              <button className="btn-ghost" onClick={() => toggleVisible(true)}>
                {t('mailMergeSelectAll')}
              </button>
              <button className="btn-ghost" onClick={() => toggleVisible(false)}>
                {t('mailMergeDeselectAll')}
              </button>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            {t('mailMergeCancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!pending || selected === 0}
            onClick={() => pending && onApply(pending)}
          >
            {t('mailMergeUseSelected', { n: selected })}
          </button>
        </div>
      </div>
    </div>
  )
}
