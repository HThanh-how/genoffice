import { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { IndexingEffectiveState } from '../../../shared/fork/indexing-mode'
import { indexingStateLine } from './indexing-mode-strings'
import './indexing-mode.css'

const POLL_MS = 4000

interface StateApi {
  getIndexingModeState?: () => Promise<{ effective: IndexingEffectiveState | null }>
}

/**
 * One quiet line in the Document index popup: "Paused: on battery" or "Running fast (4 threads)".
 * Polls only while the popup is open (it is mounted only then). Renders nothing until the
 * main process has a reading, or when the API is missing.
 */
export function IndexingStateNote({ api, lang }: { api: StateApi; lang: Lang }) {
  const [state, setState] = useState<IndexingEffectiveState | null>(null)
  useEffect(() => {
    if (typeof api.getIndexingModeState !== 'function') return
    let alive = true
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      void api
        .getIndexingModeState?.()
        .then((next) => {
          if (alive) setState(next.effective)
        })
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [api])
  if (!state) return null
  return (
    <p className="indexing-activity-power" data-paused={state.paused} aria-live="polite">
      {indexingStateLine(lang, state, true)}
    </p>
  )
}
