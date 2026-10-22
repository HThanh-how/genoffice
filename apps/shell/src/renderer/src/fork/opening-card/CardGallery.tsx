import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OpeningCardDefinition, StoredMediaAsset } from '../../../../shared/opening-card-types'
import { cardLabel } from '../../../../shared/opening-card-text'
import type { OpeningPrefs } from '../../../../shared/opening-scenes-meta'
import { AppLogoStack } from './AppMarks'
import { CardThumbnail } from './CardThumbnail'
import {
  appsUsingCard,
  computeFilterCounts,
  matchesFilter,
  orderInUseFirst,
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

export const DETAIL_PANEL_ID = 'ocs-detail-panel'

interface CardGalleryProps {
  cards: OpeningCardDefinition[]
  /** the card whose details are open under its row, if any */
  openCardId: string | null
  prefs: OpeningPrefs
  lang: string
  mediaAssets?: StoredMediaAsset[]
  /** a click on a card: open its details, or close them when they already are */
  onToggleCard: (card: OpeningCardDefinition) => void
  onCloseDetail: () => void
  onToggleFavorite: (cardId: string) => void
  /** the details of a card, drawn by the gallery right under the row of that card */
  renderDetail: (card: OpeningCardDefinition) => React.ReactNode
}

const prefersCalm = (): boolean =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

export function CardGallery({
  cards,
  openCardId,
  prefs,
  lang,
  mediaAssets,
  onToggleCard,
  onCloseDetail,
  onToggleFavorite,
  renderDetail,
}: CardGalleryProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const [filterCategory, setFilterCategory] = useState<GalleryFilterCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const gridRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const slotRef = useRef<HTMLDivElement | null>(null)
  const [layoutTick, setLayoutTick] = useState(0)
  const [slot, setSlot] = useState<{ afterId: string; notch: number } | null>(null)

  const counts = useMemo(
    () => computeFilterCounts(cards, prefs.favorites),
    [cards, prefs.favorites],
  )
  const activeFilter = resolveActiveFilter(filterCategory, counts)
  const filterKeys = visibleFilterKeys(counts)

  // Cards some app plays come first, the rest keep their order
  const ordered = useMemo(() => {
    const favSet = new Set(prefs.favorites || [])
    let list = cards.filter((c) => matchesFilter(c, activeFilter, favSet))
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter((c) => {
        const text = cardLabel(c, lang)
        return (
          c.name.toLowerCase().includes(q) ||
          text.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (c.tags && c.tags.some((t) => t.toLowerCase().includes(q))) ||
          text.description.toLowerCase().includes(q)
        )
      })
    }
    return orderInUseFirst(list, prefs)
  }, [cards, activeFilter, searchQuery, prefs, lang])

  // The details open under the row of the card that was clicked: after the last card on that row
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || typeof ResizeObserver !== 'function') return
    let width = grid.clientWidth
    const observer = new ResizeObserver(() => {
      if (grid.clientWidth !== width) {
        width = grid.clientWidth
        setLayoutTick((n) => n + 1)
      }
    })
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const openEl = openCardId ? itemRefs.current.get(openCardId) : undefined
    if (!openCardId || !openEl) {
      setSlot(null)
      return
    }
    const top = openEl.offsetTop
    let afterId = openCardId
    for (const card of ordered) {
      const el = itemRefs.current.get(card.id)
      if (el && el.offsetTop === top) afterId = card.id
    }
    const notch = openEl.offsetLeft + openEl.offsetWidth / 2
    setSlot((prev) =>
      prev && prev.afterId === afterId && Math.abs(prev.notch - notch) < 1
        ? prev
        : { afterId, notch },
    )
  }, [openCardId, ordered, layoutTick])

  // After a click, bring the details into view if they opened below the fold
  const scrolledFor = useRef<string | null>(null)
  useEffect(() => {
    if (!openCardId) {
      scrolledFor.current = null
      return
    }
    if (!slot || scrolledFor.current === openCardId) return
    scrolledFor.current = openCardId
    const el = slotRef.current
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: prefersCalm() ? 'auto' : 'smooth' })
    }
  }, [openCardId, slot])

  const usage = useMemo(() => {
    const map = new Map<string, ReturnType<typeof appsUsingCard>>()
    for (const card of ordered) map.set(card.id, appsUsingCard(prefs, card.id))
    return map
  }, [ordered, prefs])

  const focusCard = (id: string | undefined) => {
    if (id) itemRefs.current.get(id)?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    const count = ordered.length
    let next = -1
    if (e.key === 'ArrowRight') next = (index + 1) % count
    else if (e.key === 'ArrowLeft') next = (index - 1 + count) % count
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // the card right below / above: the nearest one in the next row at the same place
      const here = itemRefs.current.get(ordered[index]!.id)
      if (here) {
        const dir = e.key === 'ArrowDown' ? 1 : -1
        let best = -1
        let bestScore = Infinity
        ordered.forEach((c, i) => {
          const el = itemRefs.current.get(c.id)
          if (!el || (dir > 0 ? el.offsetTop <= here.offsetTop : el.offsetTop >= here.offsetTop))
            return
          const score =
            Math.abs(el.offsetTop - here.offsetTop) * 10 + Math.abs(el.offsetLeft - here.offsetLeft)
          if (score < bestScore) {
            bestScore = score
            best = i
          }
        })
        next = best
      }
    } else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = count - 1
    else if (e.key === ' ' || e.key === 'Enter') {
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      onToggleCard(ordered[index]!)
      return
    }
    if (next >= 0) {
      e.preventDefault()
      focusCard(ordered[next]?.id)
    }
  }

  const favSet = new Set(prefs.favorites || [])
  const openCard = openCardId ? (ordered.find((c) => c.id === openCardId) ?? null) : null

  return (
    <div className="ocs-gallery-section">
      {/* Search and Filters Toolbar */}
      <div className="ocs-gallery-toolbar">
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
      </div>

      {/* Cards Grid */}
      <div
        ref={gridRef}
        className="ocs-gallery-grid"
        role="group"
        aria-label={isVi ? 'Danh sách thẻ mở tệp' : 'Opening card library'}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && openCard) {
            e.stopPropagation()
            onCloseDetail()
            focusCard(openCard.id)
          }
        }}
      >
        {ordered.length === 0 ? (
          <div className="ocs-empty-gallery">
            <p>
              {cards.length === 0
                ? isVi
                  ? 'Chưa có thẻ nào. Tạo thẻ bằng AI hoặc thêm hình ảnh ở góc trên.'
                  : 'No cards yet. Create one with AI or add media from the menu above.'
                : isVi
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
          ordered.map((card, idx) => {
            const isOpen = openCardId === card.id
            const isFocusable = openCard ? isOpen : idx === 0
            const isFav = favSet.has(card.id)
            const apps = usage.get(card.id) ?? []
            const inUse = apps.length > 0
            const text = cardLabel(card, lang)

            return (
              <React.Fragment key={card.id}>
                <div
                  ref={(el) => {
                    if (el) itemRefs.current.set(card.id, el)
                    else itemRefs.current.delete(card.id)
                  }}
                  role="button"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? DETAIL_PANEL_ID : undefined}
                  aria-label={inUse ? `${text.name} (${isVi ? 'đang dùng' : 'in use'})` : text.name}
                  tabIndex={isFocusable ? 0 : -1}
                  className={`ocs-gallery-card-item${isOpen ? ' is-open' : ''}${inUse ? ' is-inuse' : ''}`}
                  onClick={() => onToggleCard(card)}
                  onKeyDown={(e) => handleKeyDown(e, idx)}
                >
                  {/* Visual Thumbnail Surface */}
                  <div className="ocs-card-thumbnail-wrap">
                    <CardThumbnail card={card} isVi={isVi} mediaAssets={mediaAssets} />
                    {inUse && (
                      <span className="ocs-inuse-badge" aria-hidden="true">
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                        {isVi ? 'Đang dùng' : 'In use'}
                      </span>
                    )}

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

                    {/* The apps that play this card, bottom right */}
                    {inUse && (
                      <span className="ocs-card-apps">
                        <AppLogoStack apps={apps} isVi={isVi} size={inUse ? 18 : 16} />
                      </span>
                    )}
                  </div>

                  {/* Card name */}
                  <div className="ocs-card-meta">
                    <span className="ocs-card-name" title={text.name}>
                      {text.name}
                    </span>
                  </div>
                </div>

                {openCard && slot?.afterId === card.id && (
                  <div
                    key={`detail-${openCard.id}`}
                    ref={slotRef}
                    className="ocs-detail-slot"
                    style={{ '--ocs-notch': `${slot.notch}px` } as React.CSSProperties}
                  >
                    {renderDetail(openCard)}
                  </div>
                )}
              </React.Fragment>
            )
          })
        )}
      </div>
    </div>
  )
}
