import { useState, type ReactNode } from 'react'
import type { IndexedFolder } from '../../../shared/fork/document-index-api'
import type { HomeApi } from '../../../shared/home-api'
import { INDEXING_MODES, type IndexingMode } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { useI18n } from '../locale'
import { TEXT, EN } from './index-dashboard-i18n'
import { indexingModeKeys, indexingString } from './indexing-mode-strings'
import { useIndexStatusModel, type StatusModelInput } from './use-index-status-model'
import { useCommonPlaces } from './IndexAddFolder'
import { IndexLocations } from './IndexLocations'
import { IndexAttention } from './IndexAttention'
import { IndexAdvanced } from './IndexAdvanced'
import { withoutModel } from './index-issue-groups'

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="set-group ixc-group">
      <h2 className="set-group-title">
        <span className="set-group-text">
          {title}
          {hint && <span className="set-group-hint">{hint}</span>}
        </span>
      </h2>
      <div className="set-group-body">{children}</div>
    </section>
  )
}

export interface IndexSettingsPageProps extends StatusModelInput {
  api: HomeApi
  folders: IndexedFolder[]
  attention: IndexIssueSummary | null
  busy: boolean
  /** no reading has arrived yet: 'loading' while waiting, 'failed' after an error */
  unknown: 'loading' | 'failed' | null
  onRefresh: () => void
  advancedOpen: boolean
  advancedFocus: 'ignore' | undefined
  advancedRef: React.Ref<HTMLElement>
  onToggleAdvanced: () => void
  onTogglePause: () => void
  onRetryModel: () => void
  onChoose: () => void
  onChanged: () => void
  onNote: (message: string) => void
  onRefreshFolders: () => void
}

/**
 * The same job as a settings page: one card per topic, one row per setting with its control on the
 * right. The index is a switch, the background effort is a choice, the folders are a table you act on.
 */
export function IndexSettingsPage(props: IndexSettingsPageProps) {
  const { api, folders, attention } = props
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const s = d.screen
  const num = (n: number) => n.toLocaleString(dateLocale)
  const model = useIndexStatusModel(props)
  const [reviewOpen, setReviewOpen] = useState(false)
  const places = useCommonPlaces(api, true, props.onChanged)
  const [mode, setMode] = useState<IndexingMode | null>(null)
  const shownMode = mode ?? props.mode?.mode ?? 'balanced'
  const modelFailing = model.head.kind === 'modelError'
  const list = modelFailing ? withoutModel(attention) : attention
  const problems = (list?.groups ?? []).length > 0 ? model.problems : 0

  const changeMode = (next: IndexingMode) => {
    setMode(next)
    void Promise.resolve(api.setIndexingMode(next)).catch(() => setMode(null))
  }

  return (
    <div className="ixc">
      <Group title={s.cIndex}>
        {props.unknown ? (
          <div className="set-field" aria-busy={props.unknown === 'loading'}>
            {props.unknown === 'failed' ? (
              <>
                <div className="set-field-stack ixc-grow">
                  <div className="set-field-label">{s.failed}</div>
                </div>
                <button type="button" className="ix-btn" onClick={props.onRefresh}>
                  {s.retry}
                </button>
              </>
            ) : (
              <div className="ixc-grow" aria-label={s.loading}>
                <span className="ix-skel ix-skel-title" />
              </div>
            )}
          </div>
        ) : (
          <div className="set-field">
            <div className="set-field-stack ixc-grow">
              <div className="set-field-label">{model.title}</div>
              {model.meta.length > 0 && (
                <div className="set-field-desc">{model.meta.join(' · ')}</div>
              )}
            </div>
            {modelFailing ? (
              <button
                type="button"
                className="ix-btn"
                disabled={props.busy}
                onClick={props.onRetryModel}
              >
                {s.retry}
              </button>
            ) : (
              <button
                type="button"
                className="set-switch"
                role="switch"
                aria-checked={model.enabled}
                aria-label={s.cIndexOn}
                disabled={props.busy}
                onClick={props.onTogglePause}
              />
            )}
          </div>
        )}
        {!props.unknown && model.showBar && (
          <div className="ixc-bar-row">
            <div
              className={`ix-bar${model.head.percent === null ? ' is-indeterminate' : ''}`}
              role="progressbar"
              aria-label={model.title}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(model.head.percent !== null ? { 'aria-valuenow': model.head.percent } : {})}
            >
              <span
                style={
                  model.head.percent !== null
                    ? { width: `${Math.max(2, model.head.percent)}%` }
                    : {}
                }
              />
            </div>
          </div>
        )}
        <div className="set-field">
          <div className="set-field-stack ixc-grow">
            <div className="set-field-label">{s.cBackground}</div>
            <div className="set-field-desc">
              {indexingString(lang, indexingModeKeys(shownMode).desc)}
            </div>
          </div>
          <select
            className="ixc-select"
            value={shownMode}
            aria-label={s.cBackground}
            onChange={(event) => changeMode(event.target.value as IndexingMode)}
          >
            {INDEXING_MODES.map((m) => (
              <option key={m} value={m}>
                {indexingString(lang, indexingModeKeys(m).label)}
              </option>
            ))}
          </select>
        </div>
      </Group>

      <Group title={s.folders} hint={num(folders.length)}>
        <IndexLocations
          api={api}
          folders={folders}
          onAdd={props.onChoose}
          onRefresh={props.onRefreshFolders}
          onNote={props.onNote}
        />
      </Group>

      <Group title={s.common}>
        {(['documents', 'downloads', 'desktop'] as const).map((id) => {
          const entry = places.entries.find((e) => e.id === id)
          const label = {
            documents: s.locDocuments,
            downloads: s.locDownloads,
            desktop: s.locDesktop,
          }[id]
          return (
            <div className="set-field" key={id}>
              <div className="set-field-stack ixc-grow">
                <div className="set-field-label">{label}</div>
                {entry?.path && <div className="set-field-desc">{entry.path}</div>}
              </div>
              <button
                type="button"
                className="set-switch"
                role="switch"
                aria-checked={!!entry?.enabled}
                aria-label={label}
                disabled={places.busy !== null}
                onClick={() => void places.toggle(id, !entry?.enabled)}
              />
            </div>
          )
        })}
      </Group>

      <Group title={s.attention}>
        <div className="set-field">
          <div className="set-field-stack ixc-grow">
            <div className="set-field-label">
              {problems > 0 ? s.cNeedCount.replace('{n}', num(problems)) : s.cNothing}
            </div>
          </div>
          {(list?.groups.length ?? 0) > 0 && (
            <button
              type="button"
              className="ix-btn"
              aria-expanded={reviewOpen}
              onClick={() => setReviewOpen((v) => !v)}
            >
              {reviewOpen ? s.cHide : s.cReview}
            </button>
          )}
        </div>
        {reviewOpen && (
          <div className="ixc-review">
            <IndexAttention bare api={api} attention={list} onChanged={props.onChanged} />
          </div>
        )}
      </Group>

      <IndexAdvanced
        ref={props.advancedRef as never}
        api={api}
        open={props.advancedOpen}
        focus={props.advancedFocus}
        onToggle={props.onToggleAdvanced}
      />
    </div>
  )
}
