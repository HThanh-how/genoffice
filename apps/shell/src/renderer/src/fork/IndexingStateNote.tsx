import { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { AgyOcrStatus } from '../../../shared/fork/agy-ocr'
import type { IndexingEffectiveState } from '../../../shared/fork/indexing-mode'
import { indexingStateLine } from './indexing-mode-strings'
import { AgyOcrNote } from './AgyOcrNote'
import { readIndexRequest } from './index-request'
import './indexing-mode.css'

const POLL_MS = 4000

interface StateApi {
  getIndexingModeState?: () => Promise<{ effective: IndexingEffectiveState | null }>
  getAgyOcrStatus?: () => Promise<AgyOcrStatus | null>
}

/**
 * One quiet line in the Document index popup: "Paused: on battery" or "Running fast (4 threads)".
 * Polls only while the popup is open (it is mounted only then). Renders nothing until the
 * main process has a reading, or when the API is missing.
 */
export function IndexingStateNote({ api, lang }: { api: StateApi; lang: Lang }) {
  const [state, setState] = useState<IndexingEffectiveState | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        if (api.getIndexingModeState && document.visibilityState === 'visible') {
          const next = await readIndexRequest(
            () => api.getIndexingModeState!(),
            (value): value is { effective: IndexingEffectiveState | null } =>
              !!value && typeof value === 'object' && 'effective' in value,
          )
          if (alive) setState(next.effective)
        }
      } catch {
        if (alive) setState(null)
      } finally {
        if (alive) timer = setTimeout(() => void load(), POLL_MS)
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [api])

  return (
    <>
      {state && (
        <p className="indexing-activity-power" data-paused={state.paused} aria-live="polite">
          {indexingStateLine(lang, state, true)}
        </p>
      )}
      <AgyOcrNote api={api} lang={lang} />
    </>
  )
}
