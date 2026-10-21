import { useMemo, useState } from 'react'
import type { IgnoreRule } from '../../../../shared/fork/document-index-api'
import { isFolderIgnoreRule } from '../../../../shared/fork/folder-ignore'
import type { StudioStrings } from './studio-strings'
import type { RuleFilters } from './policy-ui-types'
import {
  clampPage,
  filterRules,
  isEditableRule,
  isPageFullySelected,
  pageCount,
  pageSelectionIds,
  pageSlice,
  rowDescription,
  ruleSource,
  scopeLabel,
  selectedEditableCount,
} from './policy-ui-state'
import {
  IconChevronDown,
  IconChevronUp,
  IconFile,
  IconFilter,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from './studio-icons'

export interface RulesPanelProps {
  strings: StudioStrings
  rules: IgnoreRule[]
  roots: string[]
  filters: RuleFilters
  onFiltersChange: (filters: RuleFilters) => void
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  selected: Set<string>
  onToggleSelect: (id: string) => void
  onSelectPage: (ids: string[]) => void
  onClearSelection: () => void
  onBulkEnable: (enabled: boolean) => void
  onBulkDelete: () => void
  onAddRule: () => void
  onEditRule: (rule: IgnoreRule) => void
  onDeleteRule: (rule: IgnoreRule) => void
  onToggleRule: (rule: IgnoreRule) => void
  onOpenIgnoreFile: (root: string) => void
  saving: boolean
}

const PAGE_SIZES = [25, 50, 100]

function sourceLabel(d: StudioStrings, source: 'user' | '.genofficeignore' | 'preset'): string {
  if (source === 'user') return d.sourceCustom
  if (source === '.genofficeignore') return d.sourceFile
  return d.sourcePreset
}

export function RulesPanel(props: RulesPanelProps) {
  const {
    strings: d,
    rules,
    roots,
    filters,
    onFiltersChange,
    page,
    pageSize,
    onPageChange,
    onPageSizeChange,
    selected,
    onToggleSelect,
    onSelectPage,
    onClearSelection,
    onBulkEnable,
    onBulkDelete,
    onAddRule,
    onEditRule,
    onDeleteRule,
    onToggleRule,
    onOpenIgnoreFile,
    saving,
  } = props

  const [filtersOpen, setFiltersOpen] = useState(false)

  const filtered = useMemo(() => filterRules(rules, filters), [rules, filters])
  const pages = pageCount(filtered.length, pageSize)
  const safePage = clampPage(page, pages)
  const pageRules = useMemo(
    () => pageSlice(filtered, safePage, pageSize),
    [filtered, safePage, pageSize],
  )
  const selectableOnPage = pageRules.filter(isEditableRule)
  const pageIds = useMemo(() => [...pageSelectionIds(pageRules)], [pageRules])
  const fullySelected = isPageFullySelected(selected, pageRules)
  const editableSelected = selectedEditableCount(rules, selected)

  return (
    <div className="ixr-card ixr-rules">
      <div className="ixr-toolbar">
        <div className="ixr-search">
          <IconSearch />
          <input
            type="search"
            className="idx-input ixr-input"
            value={filters.search}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            placeholder={d.searchPlaceholder}
            aria-label={d.searchPlaceholder}
          />
        </div>
        <div className="ixr-segmented" role="radiogroup" aria-label={d.colAction}>
          {(['all', 'allow', 'ignore'] as const).map((action) => (
            <button
              key={action}
              type="button"
              role="radio"
              aria-checked={filters.action === action}
              className={filters.action === action ? 'active' : ''}
              onClick={() => onFiltersChange({ ...filters, action })}
            >
              <span>
                {action === 'all'
                  ? d.filterAll
                  : action === 'allow'
                    ? d.filterAllow
                    : d.filterIgnore}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ixr-btn"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <IconFilter />
          <span>{d.filtersBtn}</span>
        </button>
        <button type="button" className="ixr-btn-primary" onClick={onAddRule}>
          <IconPlus />
          <span>{d.addRule}</span>
        </button>
      </div>

      {filtersOpen && (
        <div className="ixr-filters-popover">
          <label className="ixr-filter-field">
            <span>{d.scopeLabel}</span>
            <select
              className="idx-input ixr-select"
              value={filters.scope}
              onChange={(event) => onFiltersChange({ ...filters, scope: event.target.value })}
            >
              <option value="all">{d.scopeAll}</option>
              <option value="global">{d.scopeGlobal}</option>
              {roots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          </label>
          <label className="ixr-filter-field">
            <span>{d.sourceLabel}</span>
            <select
              className="idx-input ixr-select"
              value={filters.source}
              onChange={(event) =>
                onFiltersChange({ ...filters, source: event.target.value as RuleFilters['source'] })
              }
            >
              <option value="all">{d.sourceAll}</option>
              <option value="user">{d.sourceCustom}</option>
              <option value=".genofficeignore">{d.sourceFile}</option>
              <option value="preset">{d.sourcePreset}</option>
            </select>
          </label>
          <label className="ixr-filter-field">
            <span>{d.stateLabel}</span>
            <select
              className="idx-input ixr-select"
              value={filters.state}
              onChange={(event) =>
                onFiltersChange({ ...filters, state: event.target.value as RuleFilters['state'] })
              }
            >
              <option value="all">{d.stateAll}</option>
              <option value="enabled">{d.stateEnabled}</option>
              <option value="disabled">{d.stateDisabled}</option>
            </select>
          </label>
        </div>
      )}

      {selected.size > 0 && (
        <div className="ixr-bulk" role="group" aria-label={d.colActions}>
          <span>{d.selectedSummary(selected.size, editableSelected)}</span>
          <button
            type="button"
            className="ixr-btn"
            disabled={saving || editableSelected === 0}
            onClick={() => onBulkEnable(true)}
          >
            <span>{d.bulkEnable}</span>
          </button>
          <button
            type="button"
            className="ixr-btn"
            disabled={saving || editableSelected === 0}
            onClick={() => onBulkEnable(false)}
          >
            <span>{d.bulkDisable}</span>
          </button>
          <button
            type="button"
            className="ixr-btn danger"
            disabled={saving || editableSelected === 0}
            onClick={onBulkDelete}
          >
            <IconTrash />
            <span>{d.bulkDelete}</span>
          </button>
          <button type="button" className="ixr-btn" onClick={onClearSelection}>
            <span>{d.clearSelection}</span>
          </button>
        </div>
      )}

      <table className="ixr-table">
        <thead>
          <tr>
            <th className="ixr-th-check">
              <input
                type="checkbox"
                aria-label={d.selectPage}
                title={fullySelected ? d.clearSelection : d.selectPage}
                checked={fullySelected}
                disabled={selectableOnPage.length === 0}
                onChange={() => onSelectPage(pageIds)}
              />
            </th>
            <th>{d.colRule}</th>
            <th className="ixr-th-action">{d.colAction}</th>
            <th className="ixr-th-scope">{d.colScope}</th>
            <th className="ixr-th-status">{d.colStatus}</th>
            <th className="ixr-th-actions">{d.colActions}</th>
          </tr>
        </thead>
        <tbody>
          {pageRules.map((rule) => {
            const editable = isEditableRule(rule)
            const source = ruleSource(rule)
            const folderIgnore = isFolderIgnoreRule(rule)
            const ruleName = folderIgnore ? d.folderIgnoredLabel(rule.scope) : rule.pattern
            return (
              <tr
                key={rule.id}
                className={`ixr-row${selected.has(rule.id) ? ' selected' : ''}${rule.enabled ? '' : ' off'}`}
                data-rule-id={rule.id}
              >
                <td className="ixr-td-check">
                  {editable ? (
                    <input
                      type="checkbox"
                      aria-label={`${d.selectRule}: ${ruleName}`}
                      checked={selected.has(rule.id)}
                      onChange={() => onToggleSelect(rule.id)}
                    />
                  ) : (
                    <span className="ixr-check-na" aria-hidden="true" />
                  )}
                </td>
                <td className="ixr-td-rule">
                  {folderIgnore ? (
                    <span className="ixr-pattern" title={rule.scope}>
                      {ruleName}
                    </span>
                  ) : (
                    <code className="ixr-pattern">{rule.pattern}</code>
                  )}
                  <div className="ixr-row-meta">
                    <span className={`ixr-src src-${source}`}>{sourceLabel(d, source)}</span>
                    {rowDescription(rule) && (
                      <span className="ixr-desc">{rowDescription(rule)}</span>
                    )}
                  </div>
                </td>
                <td className="ixr-td-action">
                  <span className={`ixr-action ${rule.action === 'allow' ? 'allow' : 'ignore'}`}>
                    {rule.action === 'allow' ? d.filterAllow : d.filterIgnore}
                  </span>
                </td>
                <td className="ixr-td-scope">{scopeLabel(rule.scope, d)}</td>
                <td className="ixr-td-status">
                  {editable ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={`${rule.enabled ? d.disable : d.enable}: ${ruleName}`}
                      className={`ixr-switch${rule.enabled ? ' on' : ''}`}
                      disabled={saving}
                      onClick={() => onToggleRule(rule)}
                    >
                      <span className="ixr-switch-knob" aria-hidden="true" />
                      <span>{rule.enabled ? d.stateEnabled : d.stateDisabled}</span>
                    </button>
                  ) : (
                    <span
                      className="ixr-status-static"
                      title={
                        source === '.genofficeignore' ? d.fileReadOnlyHint : d.presetReadOnlyHint
                      }
                    >
                      {rule.enabled ? d.stateEnabled : d.stateDisabled}
                    </span>
                  )}
                </td>
                <td className="ixr-td-actions">
                  {editable ? (
                    <>
                      <button
                        type="button"
                        className="ixr-icon-btn"
                        aria-label={`${d.edit}: ${rule.pattern}`}
                        title={d.edit}
                        onClick={() => onEditRule(rule)}
                      >
                        <IconPencil />
                      </button>
                      <button
                        type="button"
                        className="ixr-icon-btn danger"
                        aria-label={`${folderIgnore ? d.stopIgnoring : d.delete}: ${ruleName}`}
                        title={folderIgnore ? d.stopIgnoring : d.delete}
                        onClick={() => onDeleteRule(rule)}
                      >
                        <IconTrash />
                      </button>
                    </>
                  ) : source === '.genofficeignore' && rule.scope !== 'global' ? (
                    <button
                      type="button"
                      className="ixr-icon-btn"
                      aria-label={`${d.openFile}: ${rule.scope}`}
                      title={d.openFile}
                      onClick={() => onOpenIgnoreFile(rule.scope)}
                    >
                      <IconFile />
                    </button>
                  ) : null}
                </td>
              </tr>
            )
          })}
          {pageRules.length === 0 && (
            <tr className="ixr-empty">
              <td colSpan={6}>{rules.length === 0 ? d.emptyAllRules : d.emptyRules}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="ixr-pagination">
        <button
          type="button"
          className="ixr-btn"
          disabled={safePage <= 1}
          aria-label={d.prevPage}
          onClick={() => onPageChange(safePage - 1)}
        >
          <IconChevronUp />
        </button>
        <span>{d.pageSummary(safePage, pages, filtered.length)}</span>
        <button
          type="button"
          className="ixr-btn"
          disabled={safePage >= pages}
          aria-label={d.nextPage}
          onClick={() => onPageChange(safePage + 1)}
        >
          <IconChevronDown />
        </button>
        <label className="ixr-page-size">
          <span>{d.rowsPerPage}</span>
          <select
            className="idx-input ixr-select"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
