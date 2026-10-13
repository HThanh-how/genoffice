import { useMemo, useState } from 'react'
import type { OpeningEffectsState } from '../../../shared/home-api'
import {
  OPENING_APPS,
  type OpeningApp,
  type OpeningPrefs,
} from '../../../shared/opening-scenes-meta'
import type {
  OpeningCardDefinition,
  OpeningMaterialPreset,
  OpeningThemeMode,
} from '../../../shared/opening-card-types'
import { getAllBuiltInCards } from '../../../shared/opening-card-families'
import './opening-card-studio.css'

interface StudioProps {
  state: OpeningEffectsState
  lang: string
  onUpdateState: (next: OpeningEffectsState) => void
  onPreview: (app: OpeningApp, sceneOrCard: string) => void
}

const APP_NAMES: Record<OpeningApp, { en: string; vi: string; letter: string }> = {
  docs: { en: 'Word', vi: 'Văn bản', letter: 'W' },
  sheets: { en: 'Excel', vi: 'Bảng tính', letter: 'X' },
  slides: { en: 'PowerPoint', vi: 'Trình chiếu', letter: 'P' },
  pdf: { en: 'PDF', vi: 'PDF', letter: 'PDF' },
  markdown: { en: 'Markdown', vi: 'Markdown', letter: 'M' },
  html: { en: 'HTML', vi: 'HTML', letter: '</>' },
}

export function OpeningCardStudio({ state, lang, onUpdateState, onPreview }: StudioProps) {
  const api = window.aiOffice
  const { prefs } = state
  const isVi = lang === 'vi'

  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<
    'all' | 'curated' | 'canvas' | 'media' | 'ai' | 'favorites'
  >('all')
  const [selectedCard, setSelectedCard] = useState<OpeningCardDefinition | null>(null)
  const [showCustomizer, setShowCustomizer] = useState(false)
  const [showAiModal, setShowAiModal] = useState(false)
  const [showMediaModal, setShowMediaModal] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  // Customizer state
  const [editPreset, setEditPreset] = useState<OpeningMaterialPreset>('frosted-glass')
  const [editTheme, setEditTheme] = useState<OpeningThemeMode>('system')
  const [editOpacity, setEditOpacity] = useState(0.85)
  const [editBlur, setEditBlur] = useState(22)
  const [editRadius, setEditRadius] = useState(18)
  const [editShadow, setEditShadow] = useState(0.35)
  const [editAccent, setEditAccent] = useState('#2b7cd3')
  const [editName, setEditName] = useState('')

  // Combine built-in cards and custom cards
  const allCards: OpeningCardDefinition[] = useMemo(() => {
    const builtIn = state.builtInCards ?? getAllBuiltInCards()
    const custom = prefs.customCards ?? []
    return [...builtIn, ...custom]
  }, [state.builtInCards, prefs.customCards])

  // Filtered cards
  const filteredCards = useMemo(() => {
    const query = search.toLowerCase().trim()
    const favs = new Set(prefs.favorites ?? [])

    return allCards.filter((card) => {
      // Category filter
      if (activeCategory === 'favorites' && !favs.has(card.id)) return false
      if (activeCategory === 'curated' && card.category !== 'curated') return false
      if (activeCategory === 'canvas' && card.category !== 'canvas') return false
      if (activeCategory === 'media' && card.category !== 'media') return false
      if (activeCategory === 'ai' && card.category !== 'ai') return false

      // Search query
      if (query) {
        const matchName = card.name.toLowerCase().includes(query)
        const matchDesc = card.description?.toLowerCase().includes(query)
        const matchTag = card.tags?.some((t) => t.toLowerCase().includes(query))
        if (!matchName && !matchDesc && !matchTag) return false
      }

      return true
    })
  }, [allCards, search, activeCategory, prefs.favorites])

  // Map of card ID to apps currently assigned
  const assignedMap = useMemo(() => {
    const map = new Map<string, OpeningApp[]>()
    for (const app of OPENING_APPS) {
      const assigned = prefs.scenes[app]
      if (assigned) {
        const list = map.get(assigned) ?? []
        list.push(app)
        map.set(assigned, list)
      }
    }
    return map
  }, [prefs.scenes])

  // Handlers
  const handleToggleFavorite = (cardId: string) => {
    void api.toggleOpeningFavorite?.(cardId).then(onUpdateState)
  }

  const handleAssignToApp = (app: OpeningApp, cardId: string) => {
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      scenes: {
        ...prefs.scenes,
        [app]: cardId,
      },
    }
    void api.setOpeningPrefs?.(nextPrefs).then(onUpdateState)
  }

  const handleSetGlobal = (cardId: string) => {
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      globalCard: cardId,
    }
    void api.setOpeningPrefs?.(nextPrefs).then(onUpdateState)
  }

  const openCustomizer = (card: OpeningCardDefinition) => {
    setSelectedCard(card)
    setEditName(`${card.name} (Custom)`)
    setEditPreset(card.material.preset)
    setEditTheme(card.material.themeMode ?? 'system')
    setEditOpacity(card.material.opacity ?? 0.85)
    setEditBlur(card.material.blurPx ?? 22)
    setEditRadius(card.material.borderRadiusPx ?? 18)
    setEditShadow(card.material.shadowIntensity ?? 0.35)
    setEditAccent(card.material.accentColor ?? '#2b7cd3')
    setShowCustomizer(true)
  }

  const handleSaveCustomCard = () => {
    if (!editName.trim()) return
    const newCard: OpeningCardDefinition = {
      id: `custom:card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: editName.trim(),
      category: 'custom',
      contentKind: selectedCard?.contentKind ?? 'curated-material',
      sceneId: selectedCard?.sceneId,
      mediaAssetId: selectedCard?.mediaAssetId,
      material: {
        preset: editPreset,
        themeMode: editTheme,
        opacity: editOpacity,
        blurPx: editBlur,
        borderRadiusPx: editRadius,
        shadowIntensity: editShadow,
        accentColor: editAccent,
      },
      thumbnailColors: [editAccent, '#181b22'],
      createdAt: Date.now(),
      isBuiltIn: false,
      tags: ['custom', editPreset],
    }
    void api.saveOpeningCard?.(newCard).then((res) => {
      onUpdateState(res)
      setShowCustomizer(false)
      setStatusMessage(isVi ? 'Đã lưu thẻ tùy chỉnh!' : 'Custom card saved!')
      setTimeout(() => setStatusMessage(''), 3000)
    })
  }

  const handleDeleteCard = (cardId: string) => {
    void api.deleteOpeningCard?.(cardId).then((res) => {
      onUpdateState(res)
      if (selectedCard?.id === cardId) setSelectedCard(null)
    })
  }

  const handleMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      if (base64) {
        void api.importOpeningMedia?.(base64, file.name).then((res) => {
          if (res.ok && res.asset) {
            // Auto register card
            const newMediaCard: OpeningCardDefinition = {
              id: `custom:media_${Date.now()}`,
              name: file.name.replace(/\.[^.]+$/, ''),
              category: 'media',
              contentKind: 'personal-media',
              mediaAssetId: res.asset.assetId,
              mediaFit: 'cover',
              mediaDim: 0.3,
              material: {
                preset: 'solid',
                themeMode: 'system',
                opacity: 0.9,
                borderRadiusPx: 18,
              },
              thumbnailColors: ['#2b7cd3', '#10141d'],
              createdAt: Date.now(),
              isBuiltIn: false,
            }
            void api.saveOpeningCard?.(newMediaCard).then((finalState) => {
              onUpdateState(finalState)
              setShowMediaModal(false)
              setStatusMessage(isVi ? 'Đã tải ảnh lên thành công!' : 'Image imported successfully!')
              setTimeout(() => setStatusMessage(''), 3000)
            })
          } else if (res.error) {
            alert(res.error)
          }
        })
      }
    }
    reader.readAsDataURL(file)
  }

  const handleAiGenerate = () => {
    if (!aiPrompt.trim()) return
    setAiLoading(true)
    setAiError('')
    void api
      .generateAiCard?.({ prompt: aiPrompt })
      .then((res) => {
        setAiLoading(false)
        if (res.ok && res.card) {
          void api.saveOpeningCard?.(res.card).then((nextState) => {
            onUpdateState(nextState)
            setShowAiModal(false)
            setAiPrompt('')
            setStatusMessage(isVi ? 'Đã tạo thẻ AI thành công!' : 'AI Card generated!')
            setTimeout(() => setStatusMessage(''), 3000)
          })
        } else {
          setAiError(res.error ?? 'Generation failed')
        }
      })
      .catch((err) => {
        setAiLoading(false)
        setAiError(String(err))
      })
  }

  return (
    <div className="ocs-container">
      {/* Top Toolbar */}
      <div className="ocs-toolbar">
        <div className="ocs-toolbar-left">
          <input
            type="text"
            className="ocs-search-input"
            placeholder={isVi ? 'Tìm kiếm thẻ mở...' : 'Search opening cards...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="ocs-tabs">
            {(
              [
                { key: 'all', en: 'All', vi: 'Tất cả' },
                { key: 'curated', en: 'Curated (12)', vi: 'Mẫu đẹp (12)' },
                { key: 'canvas', en: 'Dynamic (32)', vi: 'Động (32)' },
                { key: 'media', en: 'Custom Media', vi: 'Ảnh cá nhân' },
                { key: 'ai', en: 'AI Cards', vi: 'Thẻ AI' },
                { key: 'favorites', en: 'Favorites', vi: 'Yêu thích' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`ocs-tab-btn ${activeCategory === tab.key ? 'active' : ''}`}
                onClick={() => setActiveCategory(tab.key)}
              >
                {isVi ? tab.vi : tab.en}
              </button>
            ))}
          </div>
        </div>

        <div className="ocs-toolbar-right">
          <button
            type="button"
            className="ocs-action-btn primary"
            onClick={() => setShowMediaModal(true)}
          >
            {isVi ? '+ Nhập ảnh' : '+ Import Media'}
          </button>
          <button type="button" className="ocs-action-btn" onClick={() => setShowAiModal(true)}>
            {isVi ? '✨ Tạo bằng AI' : '✨ Generate with AI'}
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className="set-field-desc" style={{ color: 'var(--accent, #2b7cd3)' }}>
          {statusMessage}
        </div>
      )}

      {/* Cards Grid */}
      <div className="ocs-grid">
        {filteredCards.map((card) => {
          const isFav = prefs.favorites?.includes(card.id)
          const assignedApps = assignedMap.get(card.id) ?? []
          const isGlobal = prefs.globalCard === card.id
          const [bg1, bg2] = card.thumbnailColors ?? ['#18233a', '#2b3e66']

          return (
            <div
              key={card.id}
              className={`ocs-card-item ${selectedCard?.id === card.id ? 'selected' : ''}`}
              onClick={() => setSelectedCard(card)}
            >
              {/* Thumbnail */}
              <div
                className="ocs-thumb-box"
                style={{
                  background: `linear-gradient(145deg, ${bg1} 0%, ${bg2} 100%)`,
                }}
              >
                <div className="ocs-thumb-badge">{card.category === 'canvas' ? '✨' : '✦'}</div>
                <button
                  type="button"
                  className={`ocs-fav-btn ${isFav ? 'active' : ''}`}
                  title={isVi ? 'Yêu thích' : 'Favorite'}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleToggleFavorite(card.id)
                  }}
                >
                  ★
                </button>
              </div>

              {/* Info */}
              <div className="ocs-card-info">
                <div className="ocs-card-title">{card.name}</div>
                {card.description && <div className="ocs-card-desc">{card.description}</div>}
                <div className="ocs-assigned-badges">
                  {isGlobal && (
                    <span
                      className="ocs-assigned-tag"
                      style={{ background: '#2b7cd3', color: '#fff' }}
                    >
                      {isVi ? 'Mặc định chung' : 'Global Default'}
                    </span>
                  )}
                  {assignedApps.map((app) => (
                    <span key={app} className="ocs-assigned-tag">
                      {isVi ? APP_NAMES[app].vi : APP_NAMES[app].en}
                    </span>
                  ))}
                </div>
              </div>

              {/* Quick Actions */}
              <div className="ocs-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="ocs-action-btn"
                  onClick={() => onPreview('docs', card.id)}
                >
                  {isVi ? 'Xem thử' : 'Preview'}
                </button>
                <button
                  type="button"
                  className="ocs-action-btn"
                  onClick={() => openCustomizer(card)}
                >
                  {isVi ? 'Tùy biến' : 'Customize'}
                </button>
                {!card.isBuiltIn && (
                  <button
                    type="button"
                    className="ocs-action-btn"
                    style={{ color: '#d32f2f' }}
                    onClick={() => handleDeleteCard(card.id)}
                  >
                    {isVi ? 'Xóa' : 'Delete'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Selected Card Assign Row */}
      {selectedCard && (
        <div className="ocs-panel">
          <div className="ocs-panel-title">
            {isVi
              ? `Gán thẻ "${selectedCard.name}" cho ứng dụng:`
              : `Assign "${selectedCard.name}" to:`}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button
              type="button"
              className="ocs-action-btn primary"
              onClick={() => handleSetGlobal(selectedCard.id)}
            >
              {isVi ? '★ Đặt làm Mặc định chung' : '★ Set as Global Default'}
            </button>
            {OPENING_APPS.map((app) => (
              <button
                key={app}
                type="button"
                className="ocs-action-btn"
                onClick={() => handleAssignToApp(app, selectedCard.id)}
              >
                + {isVi ? APP_NAMES[app].vi : APP_NAMES[app].en}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Customizer Panel */}
      {showCustomizer && selectedCard && (
        <div className="ocs-panel">
          <div className="ocs-panel-title">
            {isVi
              ? `Tùy biến chất liệu cho "${selectedCard.name}"`
              : `Customize Material for "${selectedCard.name}"`}
          </div>
          <div className="ocs-panel-body">
            {/* Controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div className="ocs-form-group">
                <label className="ocs-form-label">{isVi ? 'Tên thẻ' : 'Card Name'}</label>
                <input
                  type="text"
                  className="ocs-search-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>

              <div className="ocs-form-group">
                <label className="ocs-form-label">
                  {isVi ? 'Chất liệu (Material)' : 'Material Preset'}
                </label>
                <select
                  className="ocs-search-input"
                  value={editPreset}
                  onChange={(e) => setEditPreset(e.target.value as OpeningMaterialPreset)}
                >
                  <option value="frosted-glass">
                    {isVi ? 'Frosted Glass (Kính mờ)' : 'Frosted Glass'}
                  </option>
                  <option value="liquid-glass">
                    {isVi ? 'Liquid Glass (Kính lỏng quang học)' : 'Liquid Glass'}
                  </option>
                  <option value="minimal-monochrome">
                    {isVi ? 'Minimal Monochrome (Đơn sắc)' : 'Minimal Monochrome'}
                  </option>
                  <option value="solid">{isVi ? 'Solid (Màu đặc phẳng)' : 'Solid'}</option>
                </select>
              </div>

              <div className="ocs-form-group">
                <label className="ocs-form-label">{isVi ? 'Độ mờ (Blur)' : 'Blur Intensity'}</label>
                <div className="ocs-slider-row">
                  <input
                    type="range"
                    min="0"
                    max="48"
                    value={editBlur}
                    onChange={(e) => setEditBlur(Number(e.target.value))}
                  />
                  <span className="ocs-slider-val">{editBlur}px</span>
                </div>
              </div>

              <div className="ocs-form-group">
                <label className="ocs-form-label">
                  {isVi ? 'Độ mờ đục (Opacity)' : 'Card Opacity'}
                </label>
                <div className="ocs-slider-row">
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={editOpacity}
                    onChange={(e) => setEditOpacity(Number(e.target.value))}
                  />
                  <span className="ocs-slider-val">{Math.round(editOpacity * 100)}%</span>
                </div>
              </div>

              <div className="ocs-form-group">
                <label className="ocs-form-label">{isVi ? 'Màu điểm nhấn' : 'Accent Color'}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="color"
                    value={editAccent}
                    onChange={(e) => setEditAccent(e.target.value)}
                  />
                  <input
                    type="text"
                    className="ocs-search-input"
                    value={editAccent}
                    onChange={(e) => setEditAccent(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button
                  type="button"
                  className="ocs-action-btn primary"
                  onClick={handleSaveCustomCard}
                >
                  {isVi ? 'Lưu thẻ tùy chỉnh' : 'Save as Custom Card'}
                </button>
                <button
                  type="button"
                  className="ocs-action-btn"
                  onClick={() => setShowCustomizer(false)}
                >
                  {isVi ? 'Đóng' : 'Close'}
                </button>
              </div>
            </div>

            {/* Live Interactive CSS Preview */}
            <div className="ocs-preview-box">
              <div
                className="ocs-interactive-stage"
                style={{
                  background:
                    editPreset === 'solid'
                      ? `rgba(24, 27, 34, ${editOpacity})`
                      : editPreset === 'liquid-glass'
                        ? `linear-gradient(135deg, rgba(22, 30, 48, ${editOpacity * 0.92}) 0%, rgba(14, 18, 28, ${editOpacity}) 100%)`
                        : `rgba(20, 25, 36, ${editOpacity})`,
                  backdropFilter: editBlur > 0 ? `blur(${editBlur}px)` : 'none',
                  borderRadius: `${editRadius}px`,
                  border: `1px solid rgba(255, 255, 255, 0.15)`,
                  boxShadow: `0 14px 40px rgba(0,0,0,${editShadow * 0.8})`,
                  color: '#f3f5fa',
                }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '8px',
                      background: editAccent,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 'bold',
                      color: '#fff',
                    }}
                  >
                    W
                  </div>
                  <span style={{ fontSize: '11px', color: '#aab3c8' }}>Preview</span>
                </div>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>{editName || 'Document'}</div>
                  <div style={{ fontSize: '11px', color: '#aab3c8' }}>
                    {isVi ? 'Đang chuẩn bị tài liệu...' : 'Getting document ready...'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Media Upload Modal */}
      {showMediaModal && (
        <div className="ocs-panel">
          <div className="ocs-panel-title">
            {isVi ? 'Nhập ảnh nền cá nhân' : 'Import Personal Media'}
          </div>
          <div className="ocs-dropzone">
            <input
              type="file"
              accept="image/png, image/jpeg, image/webp, image/gif"
              style={{ display: 'none' }}
              id="ocs-file-input"
              onChange={handleMediaUpload}
            />
            <label htmlFor="ocs-file-input" style={{ cursor: 'pointer' }}>
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>📁</div>
              <div style={{ fontSize: '13px', fontWeight: 600 }}>
                {isVi ? 'Bấm để chọn ảnh từ máy' : 'Click to select image file'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--muted, #666)', marginTop: '4px' }}>
                PNG, JPEG, WebP, GIF (Tối đa 10 MB)
              </div>
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="button"
              className="ocs-action-btn"
              onClick={() => setShowMediaModal(false)}
            >
              {isVi ? 'Hủy' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* AI Generator Modal */}
      {showAiModal && (
        <div className="ocs-panel">
          <div className="ocs-panel-title">
            {isVi ? '✨ Bộ sinh thẻ bằng AI' : '✨ AI Card Generator'}
          </div>
          <div className="ocs-form-group">
            <label className="ocs-form-label">
              {isVi
                ? 'Mô tả phong cách thẻ bạn muốn (VD: Minimalist dark slate with emerald glow):'
                : 'Describe your card brief (e.g. Minimalist dark slate with emerald glow):'}
            </label>
            <textarea
              className="ocs-search-input"
              rows={3}
              placeholder="e.g. Nordic ice mist with crisp cyan borders for writing"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
            />
          </div>

          {aiError && <div style={{ color: '#d32f2f', fontSize: '12px' }}>{aiError}</div>}

          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              type="button"
              className="ocs-action-btn primary"
              disabled={aiLoading}
              onClick={handleAiGenerate}
            >
              {aiLoading ? (isVi ? 'Đang tạo...' : 'Generating...') : isVi ? 'Tạo thẻ' : 'Generate'}
            </button>
            <button type="button" className="ocs-action-btn" onClick={() => setShowAiModal(false)}>
              {isVi ? 'Đóng' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
