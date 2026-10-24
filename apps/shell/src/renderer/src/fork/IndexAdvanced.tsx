import { forwardRef } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { TEXT, EN } from './index-dashboard-i18n'
import { IconChevron } from './index-icons'
import { IndexSettingsTab } from './IndexSettingsTab'
import { IndexCardHeading } from './IndexCard'
import { IconFolder } from './index-icons'

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
    <section className="ix-section ix-advanced ix-card" ref={ref}>
      <button
        type="button"
        className="ix-disclosure"
        aria-expanded={open}
        aria-controls="ix-advanced-body"
        onClick={onToggle}
      >
        <IndexCardHeading title={s.advanced} hint={s.advancedHint} icon={<IconFolder />} />
        <span className={`ix-chev${open ? ' is-open' : ''}`} aria-hidden="true">
          <IconChevron />
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
