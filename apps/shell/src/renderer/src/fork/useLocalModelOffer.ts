import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../locale'
import { localChatCopy } from '../i18n/strings-local-chat'
import type { LocalModelStartup } from '../../../shared/local-model'
import { appNotify } from '../ui-feedback'

export interface LocalModelOfferState {
  /** there is something to show: the question, or the start that "Use now" began */
  visible: boolean
  busy: boolean
  /** the start in progress, or how it ended */
  startup: LocalModelStartup | null
  useNow(): void
  later(): void
  /** hide the start; it goes on in the background */
  dismissStartup(): void
}

/** How long "ready to chat" stays. */
const READY_MS = 5000

/**
 * The local model as AppFrame sees it: a toast when a download finishes (it shows above editor tabs
 * too), and whether the main process has an unanswered offer. Main decides and remembers; this only
 * asks again whenever the answer may have changed, which includes a provider picked elsewhere.
 */
export function useLocalModelOffer(): LocalModelOfferState {
  const { lang } = useI18n()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [startup, setStartup] = useState<LocalModelStartup | null>(null)

  useEffect(
    () =>
      window.aiOffice.onLocalModelStartup?.((next) =>
        setStartup((shown) =>
          next.phase === 'skipped' ||
          (!shown && next.phase !== 'starting' && next.phase !== 'failed')
            ? null
            : next,
        ),
      ),
    [],
  )
  useEffect(() => {
    if (startup?.phase !== 'ready') return
    const timer = setTimeout(() => setStartup(null), READY_MS)
    return () => clearTimeout(timer)
  }, [startup])

  useEffect(
    () =>
      window.aiOffice.onLocalModelDownloaded?.(() =>
        appNotify(localChatCopy(lang).downloaded, 'success'),
      ),
    [lang],
  )

  useEffect(() => {
    const api = window.aiOffice
    if (typeof api?.localModelOffer !== 'function') return
    let alive = true
    // Only the newest question counts: an older, slower answer must not bring a closed card back.
    let asked = 0
    const refresh = () => {
      const mine = ++asked
      void api.localModelOffer().then(
        (next) => {
          if (alive && mine === asked) setOpen(next)
        },
        () => undefined,
      )
    }
    refresh()
    const offOffer = api.onLocalModelOfferChanged?.(refresh)
    const offSettings = api.onAiSettingsChanged?.(refresh)
    return () => {
      alive = false
      offOffer?.()
      offSettings?.()
    }
  }, [])

  const useNow = useCallback(() => {
    if (busy) return
    setBusy(true)
    setStartup({ phase: 'starting' })
    const api = window.aiOffice
    void (async () => {
      try {
        // Read at the moment of the write, so a change made in another window is not undone.
        await api.setAiSettings({ ...(await api.getAiSettings()), provider: 'local' })
        await api.localModelAnswerOffer('use')
        setOpen(false)
      } catch (error) {
        setStartup(null)
        appNotify(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        setBusy(false)
      }
    })()
  }, [busy])

  const later = useCallback(() => {
    if (busy) return
    setOpen(false)
    void window.aiOffice.localModelAnswerOffer('later').catch(() => undefined)
  }, [busy])

  const dismissStartup = useCallback(() => setStartup(null), [])

  return { visible: open || startup !== null, busy, startup, useNow, later, dismissStartup }
}
