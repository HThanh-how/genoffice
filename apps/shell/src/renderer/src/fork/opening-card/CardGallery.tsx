import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OpeningCardDefinition, StoredMediaAsset } from '../../../../shared/opening-card-types'
import { cardLabel } from '../../../../shared/opening-card-text'
import { groupName, groupOf, visibleGroupIds } from '../../../../shared/opening-card-groups'
import type { OpeningPrefs } from '../../../../shared/opening-scenes-meta'
import { AppLogoStack } from './AppMarks'
import { CardThumbnail } from './CardThumbnail'
import { appsUsingCard, orderInUseFirst } from './studio-logic'

/** What the gallery shows: every card, the starred ones, one group, or the trash. */
export type GalleryView = 'all' | 'starred' | 'trash' | (string & {})

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
  onRemoveCard: (card: OpeningCardDefinition) => void
  onRestoreCard: (card: OpeningCardDefinition) => void
  /** permanently delete the cards of the person's own that are in the trash */
  onEmptyTrash: () => void
  onCreateGroup: (name: string) => void
  onRenameGroup: (id: string, name: string) => void
  onDeleteGroup: (id: string) => void
  /** the details of a card, drawn by the gallery right under the row of that card */
  renderDetail: (card: OpeningCardDefinition) => React.ReactNode
}

const prefersCalm = (): boolean =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

const TrashIcon = (): React.JSX.Element => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6L12 4M6.8 6.8v3.7M9.2 6.8v3.7" />
  </svg>
)

export function CardGallery({
  cards,
  openCardId,
  prefs,
  lang,
  mediaAssets,
  onToggleCard,
  onCloseDetail,
  onToggleFavorite,
  onRemoveCard,
  onRestoreCard,
  onEmptyTrash,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  renderDetail,
}: CardGalleryProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const [view, setView] = useState<GalleryView>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [naming, setNaming] = useState<{ mode: 'new' | 'rename'; value: string } | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const slotRef = useRef<HTMLDivElement | null>(null)
  const [layoutTick, setLayoutTick] = useState(0)
  const [slot, setSlot] = useState<{ afterId: string; notch: number } | null>(null)

  const removedSet = useMemo(() => new Set(prefs.removedCards ?? []), [prefs.removedCards])
  const favSet = useMemo(() => new Set(prefs.favorites ?? []), [prefs.favorites])
  const live = useMemo(() => cards.filter((c) => !removedSet.has(c.id)), [cards, removedSet])
  const trashed = useMemo(() => cards.filter((c) => removedSet.has(c.id)), [cards, removedSet])
  const groupIds = useMemo(() => visibleGroupIds(cards, prefs), [cards, prefs])
  const customInTrash = trashed.filter((c) => !c.isBuiltIn)

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const card of live) {
      const id = groupOf(card, prefs)
      map.set(id, (map.get(id) ?? 0) + 1)
    }
    return map
  }, [live, prefs])
  const starredCount = live.filter((c) => favSet.has(c.id)).length

  // A view that emptied out (last starred card un-starred, group deleted, trash emptied) falls back to all
  const activeView: GalleryView =
    view === 'starred'
      ? starredCount > 0
        ? view
        : 'all'
      : view === 'trash'
        ? trashed.length > 0
          ? view
          : 'all'
        : view === 'all' || groupIds.includes(view)
          ? view
          : 'all'
  const inTrash = activeView === 'trash'
  const activeCustomGroup = prefs.groups?.find((g) => g.id === activeView)

  // Cards some app plays come first, then the starred ones, the rest keep their order
  const ordered = useMemo(() => {
    let list =
      activeView === 'trash'
        ? trashed
        : activeView === 'starred'
          ? live.filter((c) => favSet.has(c.id))
          : activeView === 'all'
            ? live
            : live.filter((c) => groupOf(c, prefs) === activeView)
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
    return activeView === 'trash' ? list : orderInUseFirst(list, prefs)
  }, [live, trashed, favSet, activeView, searchQuery, prefs, lang])

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
    const openEl = openCardId && !inTrash ? itemRefs.current.get(openCardId) : undefined
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
  }, [openCardId, ordered, layoutTick, inTrash])

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
      if (!inTrash) onToggleCard(ordered[index]!)
      return
    } else if (e.key === 'Delete' && e.target === e.currentTarget && !inTrash) {
      e.preventDefault()
      onRemoveCard(ordered[index]!)
      return
    }
    if (next >= 0) {
      e.preventDefault()
      focusCard(ordered[next]?.id)
    }
  }

  const openCard = openCardId ? (ordered.find((c) => c.id === openCardId) ?? null) : null

  const chip = (key: string, label: React.ReactNode, count?: number, extra?: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={activeView === key}
      className={`ocs-filter-pill${activeView === key ? ' active' : ''}${extra ? ` ${extra}` : ''}`}
      onClick={() => {
        setView(key)
        setNaming(null)
        setConfirmEmpty(false)
      }}
    >
      <span>{label}</span>
      {count !== undefined && <span className="ocs-filter-count">{count}</span>}
    </button>
  )

  const submitName = () => {
    if (!naming) return
    const name = naming.value.trim()
    if (name) {
      if (naming.mode === 'new') onCreateGroup(name)
      else if (activeCustomGroup) onRenameGroup(activeCustomGroup.id, name)
    }
    setNaming(null)
  }

  return (
    <div className="ocs-gallery-section">
      {/* Groups and search */}
      <div className="ocs-gallery-toolbar">
        <div
          className="ocs-filter-tabs"
          role="group"
          aria-label={isVi ? 'Nhóm thẻ' : 'Card groups'}
        >
          {chip('all', isVi ? 'Tất cả' : 'All', live.length)}
          {(starredCount > 0 || activeView === 'starred') &&
            chip('starred', <>★ {isVi ? 'Gắn sao' : 'Starred'}</>, starredCount)}
          {groupIds.map((id) => chip(id, groupName(id, prefs, lang), counts.get(id) ?? 0))}
          {naming?.mode === 'new' ? (
            <input
              className="ocs-group-input"
              autoFocus
              value={naming.value}
              maxLength={40}
              placeholder={isVi ? 'Tên nhóm' : 'Group name'}
              aria-label={isVi ? 'Tên nhóm mới' : 'New group name'}
              onChange={(e) => setNaming({ ...naming, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitName()
                else if (e.key === 'Escape') {
                  e.stopPropagation()
                  setNaming(null)
                }
              }}
              onBlur={() => setNaming(null)}
            />
          ) : (
            <button
              type="button"
              className="ocs-filter-pill ocs-filter-add"
              onClick={() => setNaming({ mode: 'new', value: '' })}
              title={isVi ? 'Tạo nhóm mới' : 'New group'}
            >
              + {isVi ? 'Nhóm' : 'Group'}
            </button>
          )}
          {trashed.length > 0 &&
            chip(
              'trash',
              <>
                <TrashIcon /> {isVi ? 'Thùng rác' : 'Trash'}
              </>,
              trashed.length,
              'ocs-filter-trash',
            )}
        </div>
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

      {/* A group of the person's own: rename or delete it */}
      {activeCustomGroup && (
        <div className="ocs-group-actions">
          {naming?.mode === 'rename' ? (
            <input
              className="ocs-group-input"
              autoFocus
              value={naming.value}
              maxLength={40}
              aria-label={isVi ? 'Tên nhóm' : 'Group name'}
              onChange={(e) => setNaming({ ...naming, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitName()
                else if (e.key === 'Escape') {
                  e.stopPropagation()
                  setNaming(null)
                }
              }}
              onBlur={() => setNaming(null)}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => setNaming({ mode: 'rename', value: activeCustomGroup.name })}
              >
                {isVi ? 'Đổi tên nhóm' : 'Rename group'}
              </button>
              <button
                type="button"
                className="ocs-btn-danger"
                onClick={() => {
                  onDeleteGroup(activeCustomGroup.id)
                  setView('all')
                }}
              >
                {isVi ? 'Xóa nhóm (giữ các thẻ)' : 'Delete group (keeps its cards)'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Trash: what it is, and the one way to get rid of cards for good */}
      {inTrash && (
        <div className="ocs-trash-bar">
          <p>
            {isVi
              ? 'Thẻ đã xóa nằm ở đây, không hiện trong thư viện và không được chọn ngẫu nhiên. Thẻ có sẵn luôn khôi phục được.'
              : 'Removed cards wait here: they are not shown in the gallery or drawn at random. Built-in cards can always be restored.'}
          </p>
          {confirmEmpty ? (
            <span className="ocs-trash-confirm" role="alert">
              {isVi
                ? `Xóa vĩnh viễn ${customInTrash.length} thẻ của bạn?`
                : `Delete ${customInTrash.length} of your own ${customInTrash.length === 1 ? 'card' : 'cards'} for good?`}
              <button
                type="button"
                className="ocs-btn-danger"
                onClick={() => {
                  setConfirmEmpty(false)
                  onEmptyTrash()
                }}
              >
                {isVi ? 'Xóa vĩnh viễn' : 'Delete'}
              </button>
              <button type="button" onClick={() => setConfirmEmpty(false)}>
                {isVi ? 'Hủy' : 'Cancel'}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ocs-btn-danger"
              disabled={customInTrash.length === 0}
              title={
                customInTrash.length === 0
                  ? isVi
                    ? 'Chỉ thẻ do bạn tạo mới bị xóa vĩnh viễn; thẻ có sẵn ở lại để khôi phục'
                    : 'Only cards you made are deleted for good; built-in cards stay restorable'
                  : undefined
              }
              onClick={() => setConfirmEmpty(true)}
            >
              {isVi ? 'Dọn thùng rác' : 'Empty trash'}
            </button>
          )}
        </div>
      )}

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
              {live.length === 0
                ? isVi
                  ? 'Chưa có thẻ nào. Tạo thẻ bằng AI hoặc thêm hình ảnh ở góc trên.'
                  : 'No cards yet. Create one with AI or add media from the menu above.'
                : searchQuery
                  ? isVi
                    ? 'Không có thẻ nào khớp. Thử từ khóa khác.'
                    : 'No cards match. Try a different search.'
                  : isVi
                    ? 'Nhóm này chưa có thẻ. Mở một thẻ và chọn nhóm cho nó.'
                    : 'This group is empty. Open a card and choose its group.'}
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
            const inUse = apps.length > 0 && !inTrash
            const text = cardLabel(card, lang)

            return (
              <React.Fragment key={card.id}>
                <div
                  ref={(el) => {
                    if (el) itemRefs.current.set(card.id, el)
                    else itemRefs.current.delete(card.id)
                  }}
                  role={inTrash ? undefined : 'button'}
                  aria-expanded={inTrash ? undefined : isOpen}
                  aria-controls={isOpen ? DETAIL_PANEL_ID : undefined}
                  aria-label={inUse ? `${text.name} (${isVi ? 'đang dùng' : 'in use'})` : text.name}
                  tabIndex={isFocusable ? 0 : -1}
                  className={`ocs-gallery-card-item${isOpen ? ' is-open' : ''}${inUse ? ' is-inuse' : ''}${inTrash ? ' is-trashed' : ''}`}
                  onClick={() => {
                    if (!inTrash) onToggleCard(card)
                  }}
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

                    {!inTrash && (
                      <>
                        {/* Remove: to the trash, never gone at once */}
                        <button
                          type="button"
                          className="ocs-card-remove-btn"
                          aria-label={isVi ? 'Chuyển vào thùng rác' : 'Move to trash'}
                          title={isVi ? 'Chuyển vào thùng rác' : 'Move to trash'}
                          onClick={(e) => {
                            e.stopPropagation()
                            onRemoveCard(card)
                          }}
                        >
                          <TrashIcon />
                        </button>

                        {/* Star: starred cards come first in their group, and can be the pool of random mode */}
                        <button
                          type="button"
                          className={`ocs-card-fav-btn${isFav ? ' is-favorite' : ''}`}
                          aria-pressed={isFav}
                          aria-label={
                            isFav
                              ? isVi
                                ? 'Bỏ gắn sao'
                                : 'Remove star'
                              : isVi
                                ? 'Gắn sao'
                                : 'Add star'
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
                      </>
                    )}

                    {/* The apps that play this card, bottom right */}
                    {inUse && (
                      <span className="ocs-card-apps">
                        <AppLogoStack apps={apps} isVi={isVi} size={18} />
                      </span>
                    )}
                  </div>

                  {/* Card name, or what to do with a card in the trash */}
                  <div className="ocs-card-meta">
                    <span className="ocs-card-name" title={text.name}>
                      {text.name}
                    </span>
                    {inTrash && (
                      <button
                        type="button"
                        className="ocs-restore-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          onRestoreCard(card)
                        }}
                      >
                        {isVi ? 'Khôi phục' : 'Restore'}
                      </button>
                    )}
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
