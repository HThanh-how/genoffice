import { forwardRef } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { TEXT, EN } from './index-dashboard-i18n'
import { IconChevron } from './index-icons'
import { IndexSettingsTab } from './IndexSettingsTab'

/**
 * Everything that changes how indexing behaves lives behind one quiet row at the bottom, and is only
 * built once it is opened: ignore rules, background effort, PDF pages, scanned-PDF reading, storage,
 * and the reset.
 */
export const IndexAdvanced = forwardRef<
  HTMLElement,
  {
    api: HomeApi
    open: boolean
    focus: 'ignore' | undefined
    onToggle: () => void
  }
>(function IndexAdvanced({ api, open, focus, onToggle }, ref) {
  const { lang } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  return (
    <section className="ix-section ix-advanced" ref={ref}>
      <button
        type="button"
        className="ix-disclosure"
        aria-expanded={open}
        aria-controls="ix-advanced-body"
        onClick={onToggle}
      >
        <span className={`ix-chev${open ? ' is-open' : ''}`} aria-hidden="true">
          <IconChevron />
        </span>
        <span className="ix-disclosure-text">
          <strong>{s.advanced}</strong>
          <span>{s.advancedHint}</span>
        </span>
      </button>
      {open && (
        <div id="ix-advanced-body" className="ix-advanced-body">
          <IndexSettingsTab api={api} {...(focus ? { focus } : {})} />
        </div>
      )}
    </section>
  )
})
