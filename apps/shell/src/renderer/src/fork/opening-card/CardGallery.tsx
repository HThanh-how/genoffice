import React, { useMemo, useRef, useState } from 'react'
import type { OpeningCardDefinition, StoredMediaAsset } from '../../../../shared/opening-card-types'
import { OPENING_APPS, type OpeningPrefs } from '../../../../shared/opening-scenes-meta'
import { CardThumbnail } from './CardThumbnail'
import { APP_INFO } from './CardPreview'
import {
  computeFilterCounts,
  matchesFilter,
  resolveActiveFilter,
  shouldShowFilterRow,
  visibleFilterKeys,
  type GalleryFilterCategory,
} from './studio-logic'

export type { GalleryFilterCategory }

const FILTER_LABELS: Record<GalleryFilterCategory, { en: string; vi: string }> = {
  all: { en: 'All', vi: 'Tất cả' },
  'curated-material': { en: 'Materials', vi: 'Chất liệu' },
  'canvas-scene': { en: 'Motion', vi: 'Cảnh động' },
  'personal-media': { en: 'Media', vi: 'Phương tiện' },
  'ai-html': { en: 'HTML', vi: 'Thẻ HTML' },
  favorites: { en: 'Favorites', vi: 'Yêu thích' },
  custom: { en: 'Custom', vi: 'Tự tạo' },
}

interface CardGalleryProps {
  cards: OpeningCardDefinition[]
  selectedCard: OpeningCardDefinition | null
  prefs: OpeningPrefs
  lang: string
  mediaAssets?: StoredMediaAsset[]
  onSelectCard: (card: OpeningCardDefinition) => void
  onToggleFavorite: (cardId: string) => void
}

export function CardGallery({
  cards,
  selectedCard,
  prefs,
  lang,
  mediaAssets,
  onSelectCard,
  onToggleFavorite,
}: CardGalleryProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const [filterCategory, setFilterCategory] = useState<GalleryFilterCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const cardElementsRef = useRef<(HTMLDivElement | null)[]>([])

  const counts = useMemo(
    () => computeFilterCounts(cards, prefs.favorites),
    [cards, prefs.favorites],
  )
  const activeFilter = resolveActiveFilter(filterCategory, counts)
  const filterKeys = visibleFilterKeys(counts)

  const filteredCards = useMemo(() => {
    const favSet = new Set(prefs.favorites || [])
    let list = cards.filter((c) => matchesFilter(c, activeFilter, favSet))
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (c.tags && c.tags.some((t) => t.toLowerCase().includes(q))) ||
          (c.description && c.description.toLowerCase().includes(q)),
      )
    }
    return list
  }, [cards, activeFilter, searchQuery, prefs.favorites])

  // Mapping of which cards are assigned to which apps
  const cardAssignments = useMemo(() => {
    const map = new Map<string, string[]>()
    if (prefs.globalCard) {
      map.set(prefs.globalCard, [isVi ? 'Mặc định chung' : 'Global Default'])
    }
    for (const app of OPENING_APPS) {
      const overrideId = prefs.appOverrides?.[app]
      if (overrideId) {
        const appLabel = isVi ? APP_INFO[app].nameVi : APP_INFO[app].nameEn
        const existing = map.get(overrideId) ?? []
        if (!existing.includes(appLabel)) {
          existing.push(appLabel)
          map.set(overrideId, existing)
        }
      }
    }
    return map
  }, [prefs.globalCard, prefs.appOverrides, isVi])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      nextIndex = (index + 1) % filteredCards.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      nextIndex = (index - 1 + filteredCards.length) % filteredCards.length
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      onSelectCard(filteredCards[index])
      return
    }

    if (nextIndex >= 0 && filteredCards[nextIndex]) {
      onSelectCard(filteredCards[nextIndex])
      cardElementsRef.current[nextIndex]?.focus()
    }
  }

  const favSet = new Set(prefs.favorites || [])

  return (
    <div className="ocs-gallery-section">
      {/* Search and Filters Toolbar */}
      <div className="ocs-gallery-toolbar">
        <div className="ocs-search-wrapper">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="ocs-search-icon"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <path d="M10 10l4 4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="ocs-search-input"
            placeholder={isVi ? 'Tìm kiếm thẻ theo tên, từ khóa…' : 'Search cards by name or tags…'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="ocs-search-clear"
              onClick={() => setSearchQuery('')}
              aria-label={isVi ? 'Xóa tìm kiếm' : 'Clear search'}
            >
              &times;
            </button>
          )}
        </div>

        {shouldShowFilterRow(counts) && (
          <div
            className="ocs-filter-tabs"
            role="group"
            aria-label={isVi ? 'Lọc theo loại' : 'Filter by type'}
          >
            {filterKeys.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={activeFilter === key}
                className={`ocs-filter-pill${activeFilter === key ? ' active' : ''}`}
                onClick={() => setFilterCategory(key)}
              >
                <span>{isVi ? FILTER_LABELS[key].vi : FILTER_LABELS[key].en}</span>
                <span className="ocs-filter-count">{counts[key]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Cards Grid */}
      <div
        className="ocs-gallery-grid"
        role="radiogroup"
        aria-label={isVi ? 'Danh sách thẻ mở tệp' : 'Opening card library'}
      >
        {filteredCards.length === 0 ? (
          <div className="ocs-empty-gallery">
            <p>
              {isVi
                ? 'Không có thẻ nào khớp. Thử từ khóa khác.'
                : 'No cards match. Try a different search.'}
            </p>
            {searchQuery && (
              <button type="button" className="set-btn" onClick={() => setSearchQuery('')}>
                {isVi ? 'Xóa tìm kiếm' : 'Clear search'}
              </button>
            )}
          </div>
        ) : (
          (() => {
            const hasSelectedInView = filteredCards.some((c) => c.id === selectedCard?.id)
            return filteredCards.map((card, idx) => {
              const isSelected = selectedCard?.id === card.id
              const isFocusable = hasSelectedInView ? isSelected : idx === 0
              const isFav = favSet.has(card.id)
              const assignments = cardAssignments.get(card.id) || []

              return (
                <div
                  key={card.id}
                  ref={(el) => {
                    cardElementsRef.current[idx] = el
                  }}
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={isFocusable ? 0 : -1}
                  className={`ocs-gallery-card-item${isSelected ? ' is-selected' : ''}`}
                  onClick={() => onSelectCard(card)}
                  onKeyDown={(e) => handleKeyDown(e, idx)}
                >
                  {/* Visual Thumbnail Surface */}
                  <div className="ocs-card-thumbnail-wrap">
                    <CardThumbnail card={card} isVi={isVi} mediaAssets={mediaAssets} />

                    {/* Favorite star toggle button */}
                    <button
                      type="button"
                      className={`ocs-card-fav-btn${isFav ? ' is-favorite' : ''}`}
                      aria-label={
                        isFav
                          ? isVi
                            ? 'Bỏ yêu thích'
                            : 'Remove from favorites'
                          : isVi
                            ? 'Thêm vào yêu thích'
                            : 'Add to favorites'
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleFavorite(card.id)
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z" />
                      </svg>
                    </button>
                  </div>

                  {/* Card Meta & Badges */}
                  <div className="ocs-card-meta">
                    <div className="ocs-card-name-row">
                      <span className="ocs-card-name" title={card.name}>
                        {card.name}
                      </span>
                    </div>

                    {assignments.length > 0 && (
                      <span className="ocs-card-assignment-line">{assignments.join(' · ')}</span>
                    )}
                  </div>
                </div>
              )
            })
          })()
        )}
      </div>
    </div>
  )
}
