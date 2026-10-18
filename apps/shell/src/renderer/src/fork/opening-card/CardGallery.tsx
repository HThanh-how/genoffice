import React, { useMemo, useRef, useState } from 'react'
import type { OpeningCardDefinition, StoredMediaAsset } from '../../../../shared/opening-card-types'
import { OPENING_APPS, type OpeningPrefs } from '../../../../shared/opening-scenes-meta'
import { CardThumbnail } from './CardThumbnail'
import { APP_INFO } from './CardPreview'

export type GalleryFilterCategory =
  | 'all'
  | 'curated-material'
  | 'canvas-scene'
  | 'personal-media'
  | 'ai-html'
  | 'favorites'
  | 'custom'

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

  // Category counts
  const counts = useMemo(() => {
    const c = {
      all: cards.length,
      'curated-material': 0,
      'canvas-scene': 0,
      'personal-media': 0,
      'ai-html': 0,
      favorites: 0,
      custom: 0,
    }
    const favSet = new Set(prefs.favorites || [])
    for (const card of cards) {
      if (card.contentKind === 'curated-material') c['curated-material']++
      if (card.contentKind === 'canvas-scene') c['canvas-scene']++
      if (card.contentKind === 'personal-media') c['personal-media']++
      if (card.contentKind === 'ai-html' || card.contentKind === 'custom-html') c['ai-html']++
      if (favSet.has(card.id)) c.favorites++
      if (!card.isBuiltIn || card.category === 'custom') c.custom++
    }
    return c
  }, [cards, prefs.favorites])

  // Filtered list
  const filteredCards = useMemo(() => {
    let list = cards
    const q = searchQuery.trim().toLowerCase()

    if (filterCategory === 'curated-material') {
      list = list.filter((c) => c.contentKind === 'curated-material')
    } else if (filterCategory === 'canvas-scene') {
      list = list.filter((c) => c.contentKind === 'canvas-scene')
    } else if (filterCategory === 'personal-media') {
      list = list.filter((c) => c.contentKind === 'personal-media')
    } else if (filterCategory === 'ai-html') {
      list = list.filter((c) => c.contentKind === 'ai-html' || c.contentKind === 'custom-html')
    } else if (filterCategory === 'favorites') {
      const favSet = new Set(prefs.favorites || [])
      list = list.filter((c) => favSet.has(c.id))
    } else if (filterCategory === 'custom') {
      list = list.filter((c) => !c.isBuiltIn || c.category === 'custom')
    }

    if (q) {
      list = list.filter((c) => {
        return (
          c.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (c.tags && c.tags.some((t) => t.toLowerCase().includes(q))) ||
          (c.description && c.description.toLowerCase().includes(q))
        )
      })
    }

    return list
  }, [cards, filterCategory, searchQuery, prefs.favorites])

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

        {/* Filter Pills */}
        <div className="ocs-filter-tabs" role="tablist">
          {(
            [
              { key: 'all', en: 'All', vi: 'Tất cả' },
              { key: 'curated-material', en: 'Materials', vi: 'Chất liệu' },
              { key: 'canvas-scene', en: 'Motion Scenes', vi: 'Cảnh động' },
              { key: 'personal-media', en: 'Media', vi: 'Phương tiện' },
              { key: 'ai-html', en: 'HTML Cards', vi: 'Thẻ HTML' },
              { key: 'favorites', en: 'Favorites', vi: 'Yêu thích' },
              { key: 'custom', en: 'Custom', vi: 'Tự tạo' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={filterCategory === tab.key}
              className={`ocs-filter-pill${filterCategory === tab.key ? ' active' : ''}`}
              onClick={() => setFilterCategory(tab.key)}
            >
              <span>{isVi ? tab.vi : tab.en}</span>
              <span className="ocs-filter-count">{counts[tab.key]}</span>
            </button>
          ))}
        </div>
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
                ? 'Không tìm thấy thẻ nào khớp với bộ lọc hiện tại.'
                : 'No cards match the current filter criteria.'}
            </p>
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

                    {/* Badges for currently assigned applications */}
                    {assignments.length > 0 && (
                      <div className="ocs-card-assignment-tags">
                        {assignments.map((label) => (
                          <span key={label} className="ocs-assignment-tag">
                            {label}
                          </span>
                        ))}
                      </div>
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
