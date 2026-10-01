import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Lang } from '@genoffice/i18n'
import {
  validFiveHourFloors,
  validWeeklyFloors,
  weeklySchedule,
} from '@genoffice/ai-provider/agy-ocr'
import { useI18n } from '../locale'
import type {
  AgyOcrModelList,
  AgyOcrSettings as AgyOcrSettingsValue,
  AgyOcrStatus,
} from '../../../shared/fork/agy-ocr'
import {
  activityLine,
  agyOcrString,
  bucketLiveLine,
  formatCount,
  quotaDescription,
  type AgyOcrStringKey,
} from './agy-ocr-strings'
import './agy-ocr.css'

const POLL_MS = 3000

interface StatusApi {
  getAgyOcrStatus?: () => Promise<AgyOcrStatus | null>
}

/** Live reader status, polled only while the host is mounted and the window is visible. */
export function useAgyOcrStatus(
  api: StatusApi,
  intervalMs = POLL_MS,
): [AgyOcrStatus | null, () => void] {
  const [status, setStatus] = useState<AgyOcrStatus | null>(null)
  const alive = useRef(true)
  const refresh = useCallback(() => {
    if (typeof api.getAgyOcrStatus !== 'function' || document.visibilityState !== 'visible') return
    void api
      .getAgyOcrStatus()
      .then((next) => {
        if (alive.current) setStatus(next)
      })
      .catch(() => {})
  }, [api])
  useEffect(() => {
    alive.current = true
    refresh()
    const timer = window.setInterval(refresh, intervalMs)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [refresh, intervalMs])
  return [status, refresh]
}

function NumberField({
  value,
  min,
  max,
  label,
  disabled,
  onCommit,
}: {
  value: number
  min: number
  max: number
  label: string
  disabled: boolean
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const parsed = Math.round(Number(draft))
    setDraft(null)
    if (!Number.isFinite(parsed)) return
    const next = Math.min(max, Math.max(min, parsed))
    if (next !== value) onCommit(next)
  }
  return (
    <input
      type="number"
      className="set-input set-num-input"
      aria-label={label}
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') setDraft(null)
      }}
    />
  )
}

function Switch({
  checked,
  label,
  disabled,
  onToggle,
}: {
  checked: boolean
  label: string
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      className="set-switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
    />
  )
}

interface FloorField {
  id: string
  label: string
  value: number
}

/**
 * One quota bucket: a few percentage fields validated together (inline error text, saved only
 * when the whole set is valid), an "Ignore this limit" switch, and a live line with the share
 * left, today's floor and when work resumes.
 */
function QuotaBucket({
  title,
  ignoreLabel,
  ignored,
  fields,
  isValid,
  errorText,
  liveText,
  hint,
  disabled,
  onSave,
  onIgnore,
  children,
}: {
  title: string
  ignoreLabel: string
  ignored: boolean
  fields: FloorField[]
  isValid: (values: number[]) => boolean
  errorText: string
  liveText: string
  hint?: string
  disabled: boolean
  onSave: (values: number[]) => void
  onIgnore: (ignored: boolean) => void
  children?: ReactNode
}) {
  const [drafts, setDrafts] = useState<string[] | null>(null)
  const shown = drafts ?? fields.map((f) => String(f.value))
  const parsed = shown.map((text) => (text.trim() === '' ? Number.NaN : Number(text)))
  const invalid = drafts !== null && !(parsed.every(Number.isInteger) && isValid(parsed))
  const commit = () => {
    if (!drafts || invalid) return // an invalid draft stays visible next to the error text
    setDrafts(null)
    if (parsed.some((value, i) => value !== fields[i]!.value)) onSave(parsed)
  }
  const edit = (index: number, text: string) =>
    setDrafts(shown.map((current, i) => (i === index ? text : current)))
  return (
    <div className="set-agyocr-bucket" data-ignored={ignored}>
      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{title}</div>
            <div className="set-field-desc" aria-live="polite">
              {liveText}
            </div>
            {hint && <div className="set-field-desc">{hint}</div>}
          </div>
        </div>
        <label className="set-agyocr-ignore">
          <span>{ignoreLabel}</span>
          <Switch
            checked={ignored}
            label={ignoreLabel}
            disabled={disabled}
            onToggle={() => onIgnore(!ignored)}
          />
        </label>
      </div>
      {fields.map((field, index) => (
        <div className="set-field" key={field.id}>
          <div className="set-field-text">
            <div className="set-field-label">{field.label}</div>
          </div>
          <input
            type="number"
            className="set-input set-num-input"
            aria-label={`${title}: ${field.label}`}
            aria-invalid={invalid}
            min={0}
            max={100}
            step={1}
            disabled={disabled || ignored}
            value={shown[index]}
            onFocus={() => {
              if (!drafts) setDrafts(fields.map((f) => String(f.value)))
            }}
            onChange={(event) => edit(index, event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setDrafts(null)
            }}
          />
        </div>
      ))}
      {invalid && (
        <p className="set-agyocr-error" role="alert">
          {errorText}
        </p>
      )}
      {children}
    </div>
  )
}

/** Day 1..7 floors of the weekly schedule, recomputed from the values being edited. */
function WeeklyPreview({ lang, floors }: { lang: Lang; floors: number[] }) {
  return (
    <div className="set-agyocr-plan">
      <div className="set-field-desc">{agyOcrString(lang, 'scheduleHint')}</div>
      <table aria-label={agyOcrString(lang, 'scheduleTitle')}>
        <thead>
          <tr>
            {floors.map((_, day) => (
              <th key={day} scope="col">
                {agyOcrString(lang, 'scheduleDay', { n: day + 1 })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {floors.map((floor, day) => (
              <td key={day}>{floor}%</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function statusLines(
  lang: Lang,
  status: AgyOcrStatus,
): Array<{ key: string; text: string; tone?: string }> {
  const lines: Array<{ key: string; text: string; tone?: string }> = []
  const tone =
    status.activity.kind === 'halted' || status.activity.kind === 'quota-unreadable'
      ? 'warn'
      : undefined
  lines.push({
    key: 'activity',
    text: activityLine(lang, status.activity),
    ...(tone ? { tone } : {}),
  })
  if (!status.settings.enabled) return lines
  lines.push({
    key: 'today',
    text: agyOcrString(lang, 'statusToday', {
      pdfs: formatCount(lang, status.pdfsToday),
      pages: formatCount(lang, status.pagesToday),
      tokens: formatCount(lang, status.tokensToday.input + status.tokensToday.output),
    }),
  })
  lines.push({
    key: 'waiting',
    text: agyOcrString(lang, 'statusWaiting', { count: formatCount(lang, status.filesWaiting) }),
  })
  if (status.lastError && status.activity.kind !== 'halted')
    lines.push({
      key: 'error',
      tone: 'warn',
      text: agyOcrString(lang, 'statusError', { message: status.lastError.message }),
    })
  if (status.lastResult)
    lines.push({
      key: 'last',
      text: agyOcrString(lang, 'statusLast', {
        pages: status.lastResult.pages,
        file: status.lastResult.file,
      }),
    })
  return lines
}

/** Document memory -> read scanned PDFs through Antigravity: consent, model, quota reserves, live status. */
export function AgyOcrSettings() {
  const { lang } = useI18n()
  const api = window.aiOffice
  const available = typeof api?.getAgyOcrStatus === 'function'
  const [status, refresh] = useAgyOcrStatus(api ?? {})
  const [saving, setSaving] = useState(false)
  const [models, setModels] = useState<AgyOcrModelList | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const loadedModels = useRef(false)

  const loadModels = useCallback(() => {
    if (loadedModels.current || typeof api?.listAgyOcrModels !== 'function') return
    loadedModels.current = true
    setLoadingModels(true)
    void api
      .listAgyOcrModels()
      .then((list) => {
        setModels(list)
        // a failed listing may be retried the next time the picker is opened
        if (list.error || list.models.length === 0) loadedModels.current = false
      })
      .catch(() => {
        loadedModels.current = false
      })
      .finally(() => setLoadingModels(false))
  }, [api])

  const enabled = status?.settings.enabled === true
  useEffect(() => {
    if (enabled) loadModels()
  }, [enabled, loadModels])

  if (!available) return null

  const settings = status?.settings
  const save = (patch: Partial<AgyOcrSettingsValue>) => {
    setSaving(true)
    void api
      .setAgyOcrSettings(patch)
      .then(() => refresh())
      .catch(() => {})
      .finally(() => setSaving(false))
  }
  const disabled = !settings || saving
  const t = (key: AgyOcrStringKey, params?: Record<string, string | number>) =>
    agyOcrString(lang, key, params)

  const options = (models?.models ?? []).map((m) => ({
    id: m.id,
    label: m.cheapest ? `${m.id} · ${t('cheapest')}` : m.id,
  }))
  if (settings && !options.some((o) => o.id === settings.model))
    options.unshift({ id: settings.model, label: settings.model })
  const shownModel = options.find((o) => o.id === settings?.model)?.label ?? settings?.model ?? ''

  const lines = status ? statusLines(lang, status) : []
  const weeklyFloors = settings
    ? weeklySchedule({
        firstDayFloor: settings.weeklyFirstDayFloor,
        dropPerDay: settings.weeklyDropPerDay,
        minFloor: settings.weeklyMinFloor,
        ignore: settings.ignoreWeekly,
      })
    : []
  return (
    <div className="set-agyocr">
      <h4 className="set-field-label">{t('title')}</h4>
      <p className="set-field-desc">{t('desc')}</p>

      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('enable')}</div>
            <div className="set-field-desc set-agyocr-consent">{t('consent')}</div>
          </div>
        </div>
        <Switch
          checked={settings?.enabled ?? false}
          label={t('enable')}
          disabled={disabled}
          onToggle={() => settings && save({ enabled: !settings.enabled })}
        />
      </div>

      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('model')}</div>
            <div className="set-field-desc">
              {models?.error
                ? t('modelsFailed', { error: models.error })
                : loadingModels
                  ? t('modelsLoading')
                  : t('modelDesc')}
            </div>
          </div>
        </div>
        <label className="set-select-wrap" onMouseEnter={loadModels}>
          <span className="set-select-text">{shownModel}</span>
          <select
            className="set-select"
            aria-label={t('model')}
            value={settings?.model ?? ''}
            disabled={disabled}
            onFocus={loadModels}
            onChange={(event) => save({ model: event.target.value })}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h5 className="set-agyocr-subtitle">{t('quotaTitle')}</h5>
      <p className="set-field-desc">{quotaDescription(lang)}</p>
      {settings && (
        <>
          <QuotaBucket
            key={`weekly-${settings.weeklyFirstDayFloor}-${settings.weeklyDropPerDay}-${settings.weeklyMinFloor}`}
            title={t('weeklyTitle')}
            ignoreLabel={t('ignoreWeekly')}
            ignored={settings.ignoreWeekly}
            fields={[
              { id: 'first', label: t('firstDayFloor'), value: settings.weeklyFirstDayFloor },
              { id: 'drop', label: t('dropPerDay'), value: settings.weeklyDropPerDay },
              { id: 'min', label: t('minFloor'), value: settings.weeklyMinFloor },
            ]}
            isValid={([first, drop, min]) => validWeeklyFloors(first!, drop!, min!)}
            errorText={t('weeklyError')}
            liveText={bucketLiveLine(lang, 'weekly', status?.quota?.weekly, status!.activity)}
            disabled={disabled}
            onSave={([first, drop, min]) =>
              save({ weeklyFirstDayFloor: first!, weeklyDropPerDay: drop!, weeklyMinFloor: min! })
            }
            onIgnore={(ignoreWeekly) => save({ ignoreWeekly })}
          >
            <WeeklyPreview lang={lang} floors={weeklyFloors} />
          </QuotaBucket>
          <QuotaBucket
            key={`5h-${settings.fiveHourFloorStart}-${settings.fiveHourFloorEnd}`}
            title={t('fiveHourTitle')}
            ignoreLabel={t('ignoreFiveHour')}
            ignored={settings.ignoreFiveHour}
            fields={[
              { id: 'start', label: t('fiveStart'), value: settings.fiveHourFloorStart },
              { id: 'end', label: t('fiveEnd'), value: settings.fiveHourFloorEnd },
            ]}
            isValid={([start, end]) => validFiveHourFloors(start!, end!)}
            errorText={t('fiveError')}
            liveText={bucketLiveLine(lang, '5h', status?.quota?.fiveHour, status!.activity)}
            hint={t('fiveHint')}
            disabled={disabled}
            onSave={([start, end]) => save({ fiveHourFloorStart: start!, fiveHourFloorEnd: end! })}
            onIgnore={(ignoreFiveHour) => save({ ignoreFiveHour })}
          />
        </>
      )}

      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('maxPdfsPerDay')}</div>
            <div className="set-field-desc">{t('maxPdfsPerDayDesc')}</div>
          </div>
        </div>
        <NumberField
          value={settings?.maxPdfsPerDay ?? 0}
          min={0}
          max={2000}
          label={t('maxPdfsPerDay')}
          disabled={disabled}
          onCommit={(maxPdfsPerDay) => save({ maxPdfsPerDay })}
        />
      </div>

      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('maxPagesPerFile')}</div>
            <div className="set-field-desc">{t('maxPagesPerFileDesc')}</div>
          </div>
        </div>
        <NumberField
          value={settings?.maxPagesPerFile ?? 10}
          min={1}
          max={50}
          label={t('maxPagesPerFile')}
          disabled={disabled}
          onCommit={(maxPagesPerFile) => save({ maxPagesPerFile })}
        />
      </div>

      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('onlyAC')}</div>
            <div className="set-field-desc">{t('onlyACDesc')}</div>
          </div>
        </div>
        <Switch
          checked={settings?.onlyOnAC ?? true}
          label={t('onlyAC')}
          disabled={disabled}
          onToggle={() => settings && save({ onlyOnAC: !settings.onlyOnAC })}
        />
      </div>

      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('onlyIdle')}</div>
            <div className="set-field-desc">{t('onlyIdleDesc')}</div>
          </div>
        </div>
        <Switch
          checked={settings?.onlyWhenIdle ?? true}
          label={t('onlyIdle')}
          disabled={disabled}
          onToggle={() => settings && save({ onlyWhenIdle: !settings.onlyWhenIdle })}
        />
      </div>

      <ul className="set-agyocr-status" role="status" aria-live="polite">
        {lines.map((line) => (
          <li key={line.key} data-tone={line.tone}>
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
