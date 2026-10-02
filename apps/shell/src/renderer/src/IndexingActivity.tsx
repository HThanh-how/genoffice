import { useEffect, useMemo, useRef, useState } from 'react'
import { IndexProgressRing } from '@genoffice/ui'
import '@genoffice/ui/index-progress.css'
import type { HomeApi, HomeIndexingActivity } from '../../shared/home-api'
import type { Lang } from '@genoffice/i18n'
import { strings, en } from './indexing-activity-i18n'
import { activityCopy } from './indexing-activity-copy'
import {
  activityEqual,
  createAdaptivePoller,
  deriveIndexView,
  pollDelay,
} from './indexing-activity-model'
import { headline } from './indexing-activity/format'
import './indexing-activity.css'

/** Event the Home page listens for to show the Index dashboard. */
export const OPEN_INDEX_EVENT = 'genoffice-open-index'

/**
 * A small ring in the corner while documents are being read, and nothing otherwise. It never
 * opens by itself or reappears when work finishes; clicking it opens the Index page, where
 * everything about indexing lives.
 */
export function IndexingActivity({ api, lang }: { api: HomeApi; lang: Lang }) {
  const [activity, setActivity] = useState<HomeIndexingActivity | null>(null)
  const activeRef = useRef(false)
  const words = strings[lang] ?? en
  const copy = activityCopy(lang)

  useEffect(() => {
    if (!api.getIndexingActivity) return
    let mounted = true
    const poller = createAdaptivePoller({
      fetch: async () => {
        const next = await api.getIndexingActivity()
        if (!mounted) return
        setActivity((previous) => (activityEqual(previous, next) ? previous : next))
        activeRef.current = !!deriveIndexView(next)?.active
      },
      getDelay: () =>
        pollDelay({
          expanded: false,
          visible: document.visibilityState === 'visible',
          active: activeRef.current,
        }),
    })
    const onVisibility = () =>
      document.visibilityState === 'visible' ? poller.kick() : poller.reschedule()
    document.addEventListener('visibilitychange', onVisibility)
    poller.kick()
    return () => {
      mounted = false
      poller.stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [api])

  const view = useMemo(() => deriveIndexView(activity), [activity])
  if (!view || !(view.active || view.kind === 'model-error')) return null

  const label = headline(view, words, copy)
  const title =
    view.percent !== null && view.kind === 'indexing' ? `${label} · ${view.percent}%` : label
  return (
    <button
      type="button"
      className={`indexing-dot is-${view.kind}`}
      title={title}
      aria-label={title}
      onClick={() => window.dispatchEvent(new Event(OPEN_INDEX_EVENT))}
    >
      <IndexProgressRing
        percent={view.percent}
        state={view.kind === 'model-error' ? 'error' : 'running'}
        active={view.active}
        label={label}
      />
    </button>
  )
}
