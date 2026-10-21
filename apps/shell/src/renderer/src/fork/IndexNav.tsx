import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'

export type IndexTabId = 'overview' | 'sources' | 'issues' | 'settings'

export interface IndexNavProps {
  activeTab: IndexTabId
  onChangeTab: (tab: IndexTabId) => void
  issuesCount?: number
}

// Plain words under a neutral underline: no icons, no accent on the tabs.
const TABS: Array<{ id: IndexTabId }> = [
  { id: 'overview' },
  { id: 'sources' },
  { id: 'issues' },
  { id: 'settings' },
]

export function IndexNav({ activeTab, onChangeTab, issuesCount = 0 }: IndexNavProps) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN

  const tabKeys = TABS.map((t) => t.id)

  return (
    <nav className="idx-tabs" role="tablist" aria-label={d.summary.navAria}>
      {TABS.map((tab) => {
        const isSelected = activeTab === tab.id
        const label = d.tabs[tab.id]

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`index-tab-${tab.id}`}
            aria-controls="index-tab-panel"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className={`idx-tab-btn ${isSelected ? 'is-active' : ''}`}
            onClick={() => onChangeTab(tab.id)}
            onKeyDown={(event) => {
              const currentIndex = tabKeys.indexOf(tab.id)
              let nextId: IndexTabId | null = null

              if (event.key === 'Home') {
                nextId = tabKeys[0]
              } else if (event.key === 'End') {
                nextId = tabKeys[tabKeys.length - 1]
              } else if (event.key === 'ArrowRight') {
                nextId = tabKeys[(currentIndex + 1) % tabKeys.length]
              } else if (event.key === 'ArrowLeft') {
                nextId = tabKeys[(currentIndex - 1 + tabKeys.length) % tabKeys.length]
              }

              if (nextId) {
                event.preventDefault()
                onChangeTab(nextId)
                document.getElementById(`index-tab-${nextId}`)?.focus()
              }
            }}
          >
            <span className="idx-tab-text">{label}</span>
            {tab.id === 'issues' && issuesCount > 0 && (
              <span className="idx-badge" aria-label={fill(d.summary.problems, { n: issuesCount })}>
                {issuesCount.toLocaleString(dateLocale)}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
