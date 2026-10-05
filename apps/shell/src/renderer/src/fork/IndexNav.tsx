import type { ReactNode } from 'react'
import { useI18n } from '../locale'

export type IndexTabId = 'overview' | 'sources' | 'issues' | 'settings'

export interface IndexNavProps {
  activeTab: IndexTabId
  onChangeTab: (tab: IndexTabId) => void
  issuesCount?: number
}

interface TabItemConfig {
  id: IndexTabId
  labelVi: string
  labelEn: string
  icon: ReactNode
}

const TABS: TabItemConfig[] = [
  {
    id: 'overview',
    labelVi: 'Tổng quan',
    labelEn: 'Overview',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    id: 'sources',
    labelVi: 'Nguồn',
    labelEn: 'Sources',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'issues',
    labelVi: 'Cần xử lý',
    labelEn: 'Issues',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  {
    id: 'settings',
    labelVi: 'Cài đặt',
    labelEn: 'Settings',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
]

export function IndexNav({ activeTab, onChangeTab, issuesCount = 0 }: IndexNavProps) {
  const { lang, dateLocale } = useI18n()
  const isVi = lang === 'vi'

  const tabKeys = TABS.map((t) => t.id)

  return (
    <nav className="idx-tabs" role="tablist" aria-label={isVi ? 'Các mục chỉ mục' : 'Index navigation'}>
      {TABS.map((tab) => {
        const isSelected = activeTab === tab.id
        const label = isVi ? tab.labelVi : tab.labelEn

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
            <span className="idx-tab-icon">{tab.icon}</span>
            <span className="idx-tab-text">{label}</span>
            {tab.id === 'issues' && issuesCount > 0 && (
              <span className="idx-badge" aria-label={`${issuesCount} ${isVi ? 'cần xử lý' : 'issues'}`}>
                {issuesCount.toLocaleString(dateLocale)}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
