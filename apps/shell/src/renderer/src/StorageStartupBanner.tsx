import { useEffect, useState } from 'react'
import { isStorageStartupBusy, type StorageStartupState } from '../../shared/fork/storage-startup'
import { useI18n } from './locale'
import './storage-startup.css'

/**
 * Tells the person that the search index is being checked / upgraded while the window is already usable. The
 * check runs off the main thread (see main/document-memory/runtime/storage-bootstrap-runner.ts); a large legacy
 * index takes minutes, and without this line the app would look idle. Hidden once the index is open.
 */
export function StorageStartupBanner() {
  const { t } = useI18n()
  const [state, setState] = useState<StorageStartupState | null>(null)

  useEffect(() => {
    const api = window.aiOffice
    if (typeof api?.getStorageStartupState !== 'function') return
    let alive = true
    void api.getStorageStartupState().then(
      (initial) => {
        if (alive) setState((current) => current ?? initial)
      },
      () => undefined,
    )
    const off = api.onStorageStartupChanged?.((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  if (!state) return null
  if (state.phase === 'unavailable') {
    return (
      <div className="storage-startup storage-startup-warn" role="status">
        {t('storageStartupUnavailable')}
      </div>
    )
  }
  if (!isStorageStartupBusy(state)) return null
  const percent = state.phase === 'migrating' ? state.percent : null
  return (
    <div className="storage-startup" role="status" aria-live="polite">
      <div className="storage-startup-title">
        {percent === null
          ? t('storageStartupTitle')
          : t('storageStartupTitlePercent', { n: percent })}
      </div>
      <div className="storage-startup-hint">{t('storageStartupHint')}</div>
      <div className="storage-startup-bar" aria-hidden="true">
        <div
          className={
            percent === null ? 'storage-startup-fill indeterminate' : 'storage-startup-fill'
          }
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
