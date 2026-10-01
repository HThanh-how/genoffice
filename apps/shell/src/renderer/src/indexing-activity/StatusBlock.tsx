import type { ReactNode } from 'react'
import type { Lang } from '@genoffice/i18n'
import { fill, type ActivityCopy } from '../indexing-activity-copy'
import type { EtaEstimate, IndexView } from '../indexing-activity-model'
import { detail, etaText, formatCount } from './format'

/** Progress ring plus the headline, the numbers that matter and the time estimate. */
export function StatusBlock({
  view,
  ring,
  label,
  eta,
  lang,
  copy,
}: {
  view: IndexView
  ring: ReactNode
  label: string
  eta: EtaEstimate | null
  lang: Lang
  copy: ActivityCopy
}) {
  const sub = detail(view, lang, copy)
  return (
    <div className="indexing-activity-status" aria-live="polite">
      {ring}
      <div className="indexing-activity-status-copy">
        <strong>
          {label}
          {view.kind === 'indexing' && view.percent !== null && (
            <span className="indexing-activity-percent">{view.percent}%</span>
          )}
        </strong>
        {sub && <span>{sub}</span>}
        {view.kind === 'indexing' && eta && (
          <span className="indexing-activity-eta">{etaText(eta, copy)}</span>
        )}
        {view.kind === 'scanning' && view.finished > 0 && (
          <span>
            {fill(copy.progressFiles, {
              done: formatCount(view.finished, lang),
              total: formatCount(view.total, lang),
            })}
          </span>
        )}
      </div>
    </div>
  )
}
