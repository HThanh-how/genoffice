import { useEffect, useMemo, useRef, useState } from 'react'
import type { OpeningEffectsState } from '../../../shared/home-api'
import {
  DEFAULT_SCENE_FOR_APP,
  OPENING_APPS,
  resolveEffectiveOpeningCard,
  type OpeningApp,
  type OpeningPrefs,
} from '../../../shared/opening-scenes-meta'
import type {
  AiCardGenerationMode,
  GeneratedHtmlCardDraft,
  OpeningCardDefinition,
  OpeningMaterialPreset,
  OpeningThemeMode,
  StoredMediaAsset,
} from '../../../shared/opening-card-types'
import { getAllBuiltInCards } from '../../../shared/opening-card-families'
import { buildIsolatedHtmlHostDocument } from '../../../shared/opening-card-html-sanitizer'
import './opening-card-studio.css'

interface StudioProps {
  state: OpeningEffectsState
  lang: string
  onUpdateState: (next: OpeningEffectsState) => void
  onPreview: (app: OpeningApp, sceneOrCard: string) => void
}

const APP_NAMES: Record<OpeningApp, { en: string; vi: string; letter: string }> = {
  docs: { en: 'Word (.docx)', vi: 'Word (.docx)', letter: 'W' },
  sheets: { en: 'Excel (.xlsx)', vi: 'Excel (.xlsx)', letter: 'X' },
  slides: { en: 'PowerPoint (.pptx)', vi: 'PowerPoint (.pptx)', letter: 'P' },
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
  const [dragOver, setDragOver] = useState(false)
  const [mediaError, setMediaError] = useState('')

  // AI Workflow state (prompt -> generate -> preview -> approve/save or discard)
  const [aiMode, setAiMode] = useState<AiCardGenerationMode>('html')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiPreviewCard, setAiPreviewCard] = useState<OpeningCardDefinition | null>(null)
  const [aiHtmlDraft, setAiHtmlDraft] = useState<GeneratedHtmlCardDraft | null>(null)
  const [aiSubTab, setAiSubTab] = useState<'preview' | 'html' | 'css'>('preview')
  const [editDraftHtml, setEditDraftHtml] = useState('')
  const [editDraftCss, setEditDraftCss] = useState('')
  const [aiModelUsed, setAiModelUsed] = useState<string | undefined>()
  const activeAiRequestIdRef = useRef<string | null>(null)

  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const importFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (activeAiRequestIdRef.current) {
        void api.cancelAiCardGeneration?.(activeAiRequestIdRef.current)
        activeAiRequestIdRef.current = null
      }
    }
  }, [api])

  // Customizer state
  const [editPreset, setEditPreset] = useState<OpeningMaterialPreset>('frosted-glass')
  const [editTheme, setEditTheme] = useState<OpeningThemeMode>('system')
  const [editOpacity, setEditOpacity] = useState(0.85)
  const [editBlur, setEditBlur] = useState(22)
  const [editRadius, setEditRadius] = useState(18)
  const [editShadow, setEditShadow] = useState(0.35)
  const [editAccent, setEditAccent] = useState('#2b7cd3')
  const [editName, setEditName] = useState('')

  // Customizer state for HTML cards
  const [customizerCardIsHtml, setCustomizerCardIsHtml] = useState(false)
  const [customizerHtml, setCustomizerHtml] = useState('')
  const [customizerCss, setCustomizerCss] = useState('')
  const [customizerTab, setCustomizerTab] = useState<'preview' | 'html' | 'css'>('preview')
  const [customizerLoading, setCustomizerLoading] = useState(false)

  // Media map for fast asset thumbnail lookup
  const mediaMap = useMemo(() => {
    const map = new Map<string, StoredMediaAsset>()
    for (const a of state.mediaAssets ?? []) {
      map.set(a.assetId, a)
    }
    return map
  }, [state.mediaAssets])

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
      if (activeCategory === 'favorites' && !favs.has(card.id)) return false
      if (activeCategory === 'curated' && card.category !== 'curated') return false
      if (activeCategory === 'canvas' && card.category !== 'canvas') return false
      if (activeCategory === 'media' && card.category !== 'media') return false
      if (activeCategory === 'ai' && card.category !== 'ai' && card.contentKind !== 'ai-html')
        return false

      if (query) {
        const matchName = card.name.toLowerCase().includes(query)
        const matchDesc = card.description?.toLowerCase().includes(query)
        const matchTag = card.tags?.some((t) => t.toLowerCase().includes(query))
        if (!matchName && !matchDesc && !matchTag) return false
      }

      return true
    })
  }, [allCards, search, activeCategory, prefs.favorites])

  // Isolated host document for live AI HTML preview
  const aiPreviewHtmlDoc = useMemo(() => {
    if (!editDraftHtml) return ''
    return buildIsolatedHtmlHostDocument(
      editDraftHtml,
      editDraftCss,
      {
        fileName: 'Quarterly_Strategy_2026.docx',
        fileType: 'docx',
        title: isVi ? 'Đang mở tài liệu…' : 'Opening Document…',
        hint: isVi ? 'Đang tải bố cục…' : 'Loading document layout…',
        appName: 'Word (.docx)',
        accentColor: aiPreviewCard?.material?.accentColor || '#2b7cd3',
      },
      { isCardLayout: true },
    )
  }, [editDraftHtml, editDraftCss, aiPreviewCard?.material?.accentColor, isVi])

  // Isolated host document for Customizer HTML preview
  const customizerPreviewHtmlDoc = useMemo(() => {
    if (!customizerHtml) return ''
    return buildIsolatedHtmlHostDocument(
      customizerHtml,
      customizerCss,
      {
        fileName: `${editName || 'Document'}.docx`,
        fileType: 'docx',
        title: isVi ? 'Đang mở tài liệu…' : 'Opening Document…',
        hint: isVi ? 'Đang tải bố cục…' : 'Loading document layout…',
        appName: 'Word (.docx)',
        accentColor: editAccent,
      },
      { isCardLayout: true },
    )
  }, [customizerHtml, customizerCss, editName, editAccent, isVi])

  // Assigned apps map
  const assignedMap = useMemo(() => {
    const map = new Map<string, OpeningApp[]>()
    for (const app of OPENING_APPS) {
      const effective = state.effectiveScenes?.[app] ?? resolveEffectiveOpeningCard(prefs, app)
      const list = map.get(effective.id) ?? []
      list.push(app)
      map.set(effective.id, list)
    }
    return map
  }, [state.effectiveScenes, prefs])

  // Handlers
  const handleToggleFavorite = (cardId: string) => {
    void api.toggleOpeningFavorite?.(cardId).then(onUpdateState)
  }

  const handleAssignToApp = async (app: OpeningApp, cardId: string) => {
    const nextOverrides = { ...(prefs.appOverrides || {}), [app]: cardId }
    const nextScenes = { ...prefs.scenes, [app]: cardId }
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      appOverrides: nextOverrides,
      scenes: nextScenes,
    }
    try {
      const nextState = await api.setOpeningPrefs?.(nextPrefs)
      if (nextState) onUpdateState(nextState)
      setErrorMessage('')
      setStatusMessage(
        isVi ? `Đã gán thẻ cho ${APP_NAMES[app].vi}` : `Assigned card to ${APP_NAMES[app].en}`,
      )
      setTimeout(() => setStatusMessage(''), 3000)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const handleResetOverride = async (app: OpeningApp) => {
    const nextOverrides = { ...(prefs.appOverrides || {}) }
    delete nextOverrides[app]
    const nextScenes = { ...prefs.scenes }
    nextScenes[app] = DEFAULT_SCENE_FOR_APP[app]
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      appOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      scenes: nextScenes,
    }
    try {
      const nextState = await api.setOpeningPrefs?.(nextPrefs)
      if (nextState) onUpdateState(nextState)
      setErrorMessage('')
      setStatusMessage(
        isVi
          ? `Đã xóa tùy biến riêng của ${APP_NAMES[app].vi}`
          : `Reset ${APP_NAMES[app].en} override to Global Default`,
      )
      setTimeout(() => setStatusMessage(''), 3000)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSetGlobal = async (cardId: string) => {
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      globalCard: cardId,
    }
    try {
      const nextState = await api.setOpeningPrefs?.(nextPrefs)
      if (nextState) onUpdateState(nextState)
      setErrorMessage('')
      setStatusMessage(
        isVi
          ? 'Đã đặt làm Mặc định chung cho tất cả ứng dụng!'
          : 'Set as Global Default for all apps!',
      )
      setTimeout(() => setStatusMessage(''), 3000)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const openCustomizer = async (card: OpeningCardDefinition) => {
    setSelectedCard(card)
    setEditName(`${card.name} (Custom)`)
    setEditPreset(card.material.preset)
    setEditTheme(card.material.themeMode ?? 'system')
    setEditOpacity(card.material.opacity ?? 0.85)
    setEditBlur(card.material.blurPx ?? 22)
    setEditRadius(card.material.borderRadiusPx ?? 18)
    setEditShadow(card.material.shadowIntensity ?? 0.35)
    setEditAccent(card.material.accentColor ?? '#2b7cd3')
    setCustomizerTab('preview')

    if (card.contentKind === 'ai-html' && card.htmlAssetId) {
      setCustomizerCardIsHtml(true)
      setCustomizerLoading(true)
      try {
        const asset = await api.readOpeningHtmlCard?.(card.htmlAssetId)
        if (asset) {
          setCustomizerHtml(asset.html)
          setCustomizerCss(asset.css)
        } else {
          setCustomizerHtml('')
          setCustomizerCss('')
        }
      } catch {
        setCustomizerHtml('')
        setCustomizerCss('')
      } finally {
        setCustomizerLoading(false)
      }
    } else {
      setCustomizerCardIsHtml(false)
      setCustomizerHtml('')
      setCustomizerCss('')
    }
    setShowCustomizer(true)
  }

  const handleSaveCustomCard = async () => {
    if (!editName.trim()) return

    if (customizerCardIsHtml && customizerHtml) {
      const newCard: OpeningCardDefinition = {
        id: `custom:card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: editName.trim(),
        category: 'custom',
        contentKind: 'ai-html',
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
        tags: ['custom', 'ai-html'],
      }
      try {
        const res = await api.saveOpeningHtmlCard?.({
          card: newCard,
          html: customizerHtml,
          css: customizerCss,
        })
        if (res) {
          onUpdateState(res)
          setShowCustomizer(false)
          setErrorMessage('')
          setStatusMessage(isVi ? 'Đã lưu thẻ tùy chỉnh!' : 'Custom card saved!')
          setTimeout(() => setStatusMessage(''), 3000)
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      }
      return
    }

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
    try {
      const res = await api.saveOpeningCard?.(newCard)
      if (res) {
        onUpdateState(res)
        setShowCustomizer(false)
        setErrorMessage('')
        setStatusMessage(isVi ? 'Đã lưu thẻ tùy chỉnh!' : 'Custom card saved!')
        setTimeout(() => setStatusMessage(''), 3000)
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeleteCard = async (cardId: string) => {
    try {
      const res = await api.deleteOpeningCard?.(cardId)
      if (res) {
        onUpdateState(res)
        if (selectedCard?.id === cardId) setSelectedCard(null)
        setErrorMessage('')
        setStatusMessage(isVi ? 'Đã xóa thẻ.' : 'Card deleted.')
        setTimeout(() => setStatusMessage(''), 3000)
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const processImageFile = (file: File) => {
    setMediaError('')
    if (file.size > 10 * 1024 * 1024) {
      setMediaError(
        isVi ? 'Kích thước tệp vượt quá giới hạn 10 MB.' : 'File size exceeds maximum 10 MB limit.',
      )
      return
    }
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (!allowed.includes(file.type)) {
      setMediaError(
        isVi
          ? 'Định dạng ảnh không được hỗ trợ. Chỉ chấp nhận PNG, JPEG, WebP, GIF.'
          : 'Unsupported image format. Allowed formats: PNG, JPEG, WebP, GIF.',
      )
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      if (base64) {
        void api.importOpeningMedia?.(base64, file.name).then((res) => {
          if (res.ok && res.asset) {
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
            setMediaError(res.error)
          }
        })
      }
    }
    reader.readAsDataURL(file)
  }

  const handleMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processImageFile(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) processImageFile(file)
  }

  // Real AI generation workflow (request -> preview -> explicit user save)
  const handleAiGenerate = async () => {
    if (!aiPrompt.trim() || aiLoading) return
    const requestId = `aicard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    activeAiRequestIdRef.current = requestId
    setAiLoading(true)
    setAiError('')
    setAiPreviewCard(null)
    setAiHtmlDraft(null)
    setAiModelUsed(undefined)

    try {
      const res = await api.generateAiCard?.({ prompt: aiPrompt, requestId, mode: aiMode })
      if (activeAiRequestIdRef.current !== requestId) {
        // Request was superseded or cancelled
        return
      }
      setAiLoading(false)
      activeAiRequestIdRef.current = null
      if (res?.ok) {
        if (res.modeUsed === 'html' && res.htmlDraft && aiMode === 'html') {
          setAiHtmlDraft(res.htmlDraft)
          setAiPreviewCard(res.card ?? null)
          setEditDraftHtml(res.htmlDraft.html)
          setEditDraftCss(res.htmlDraft.css)
          setAiModelUsed(res.modelUsed)
          setAiSubTab('preview')
        } else if (res.modeUsed === 'style' && res.card && aiMode === 'style') {
          setAiPreviewCard(res.card)
          setAiHtmlDraft(null)
          setAiModelUsed(res.modelUsed)
        } else if (res.modeUsed === 'image' && res.card && aiMode === 'image') {
          setAiPreviewCard(res.card)
          setAiHtmlDraft(null)
          setAiModelUsed(res.modelUsed)
        } else {
          setAiError(
            isVi
              ? 'Phản hồi từ AI không khớp với chế độ đã chọn.'
              : 'AI response does not match the selected generation mode.',
          )
        }
      } else {
        setAiError(res?.error ?? 'AI generation failed')
      }
    } catch (err) {
      if (activeAiRequestIdRef.current === requestId) {
        setAiLoading(false)
        activeAiRequestIdRef.current = null
        setAiError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleCancelAiGenerate = async () => {
    const reqId = activeAiRequestIdRef.current
    activeAiRequestIdRef.current = null
    setAiLoading(false)
    if (reqId) {
      await api.cancelAiCardGeneration?.(reqId)
    }
    setAiError(isVi ? 'Đã hủy quá trình tạo thẻ.' : 'Card generation cancelled.')
  }

  const handleApproveAiCard = async () => {
    if (aiMode === 'html' && aiHtmlDraft) {
      try {
        const cardToSave: OpeningCardDefinition = {
          id:
            aiPreviewCard?.id ||
            `custom:card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: aiPreviewCard?.name || aiHtmlDraft.name,
          description: aiPreviewCard?.description || aiHtmlDraft.description,
          category: 'ai',
          contentKind: 'ai-html',
          material: aiPreviewCard?.material ?? {
            preset: 'frosted-glass',
            themeMode: aiHtmlDraft.themeMode ?? 'system',
            accentColor: aiHtmlDraft.accentColor ?? '#2b7cd3',
          },
          thumbnailColors: [aiHtmlDraft.accentColor ?? '#2b7cd3', '#181b22'],
          createdAt: Date.now(),
          isBuiltIn: false,
          tags: ['ai-generated', 'ai-html'],
        }
        const nextState = await api.saveOpeningHtmlCard?.({
          card: cardToSave,
          html: editDraftHtml,
          css: editDraftCss,
        })
        if (nextState) {
          onUpdateState(nextState)
          setShowAiModal(false)
          setAiPreviewCard(null)
          setAiHtmlDraft(null)
          setAiPrompt('')
          setErrorMessage('')
          setStatusMessage(
            isVi ? 'Đã lưu thẻ HTML AI vào bộ sưu tập!' : 'AI HTML card saved to your collection!',
          )
          setTimeout(() => setStatusMessage(''), 3000)
        }
      } catch (err) {
        setAiError(err instanceof Error ? err.message : String(err))
      }
      return
    }

    if (!aiPreviewCard) return
    try {
      const nextState = await api.saveOpeningCard?.(aiPreviewCard)
      if (nextState) {
        onUpdateState(nextState)
        setShowAiModal(false)
        setAiPreviewCard(null)
        setAiPrompt('')
        setErrorMessage('')
        setStatusMessage(
          isVi ? 'Đã lưu thẻ AI vào bộ sưu tập!' : 'AI card saved to your collection!',
        )
        setTimeout(() => setStatusMessage(''), 3000)
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err))
    }
  }

  // Export & Import handlers
  const handleExport = async () => {
    try {
      const json = await api.exportOpeningCards?.()
      if (!json) return
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `genoffice-opening-cards-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      setStatusMessage(isVi ? 'Đã xuất gói thẻ thành công!' : 'Opening cards exported!')
      setTimeout(() => setStatusMessage(''), 3000)
    } catch (err) {
      alert(String(err))
    }
  }

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const text = reader.result as string
      if (text) {
        const res = await api.importOpeningCards?.(text)
        if (res?.ok && res.state) {
          onUpdateState(res.state)
          setStatusMessage(
            isVi
              ? `Đã nhập thành công ${res.count} thẻ!`
              : `Successfully imported ${res.count} cards!`,
          )
          setTimeout(() => setStatusMessage(''), 3000)
        } else if (res?.error) {
          alert(res.error)
        }
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div className="ocs-container">
      {/* Active Application Assignments Overview Bar */}
      <div className="ocs-overview">
        {OPENING_APPS.map((app) => {
          const effective = state.effectiveScenes?.[app] ?? resolveEffectiveOpeningCard(prefs, app)
          const matchedCard = allCards.find((c) => c.id === effective.id)
          const cardName = matchedCard?.name ?? effective.id

          return (
            <div key={app} className="ocs-app-pill">
              <div className="ocs-app-header">
                <span>{APP_NAMES[app].vi && isVi ? APP_NAMES[app].vi : APP_NAMES[app].en}</span>
                <span
                  className={`ocs-app-badge ${
                    effective.source === 'global'
                      ? 'global'
                      : effective.source === 'override'
                        ? 'override'
                        : 'default'
                  }`}
                >
                  {effective.source === 'global'
                    ? isVi
                      ? 'Mặc định chung'
                      : 'Global'
                    : effective.source === 'override'
                      ? isVi
                        ? 'Tùy biến riêng'
                        : 'Override'
                      : isVi
                        ? 'Gốc'
                        : 'Default'}
                </span>
              </div>
              <div className="ocs-app-card-name" title={cardName}>
                {cardName}
              </div>
              {effective.source === 'override' && (
                <button
                  type="button"
                  className="ocs-reset-override-btn"
                  onClick={() => handleResetOverride(app)}
                  title={isVi ? 'Khôi phục về Mặc định chung' : 'Reset to Global Default'}
                >
                  {isVi ? '↺ Về mặc định chung' : '↺ Reset override'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Master Toolbar */}
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
                { key: 'curated', en: 'Curated', vi: 'Mẫu đẹp' },
                { key: 'canvas', en: 'Dynamic', vi: 'Động' },
                { key: 'media', en: 'Personal Media', vi: 'Ảnh cá nhân' },
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
          <button
            type="button"
            className="ocs-action-btn"
            onClick={() => {
              setShowAiModal(true)
              setAiError('')
              setAiPreviewCard(null)
            }}
          >
            {isVi ? '✨ Tạo bằng AI' : '✨ Generate with AI'}
          </button>
          <button type="button" className="ocs-action-btn" onClick={handleExport}>
            {isVi ? 'Xuất thẻ' : 'Export'}
          </button>
          <button
            type="button"
            className="ocs-action-btn"
            onClick={() => importFileInputRef.current?.click()}
          >
            {isVi ? 'Nhập thẻ' : 'Import'}
          </button>
          <input
            ref={importFileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </div>
      </div>

      {statusMessage && (
        <div className="set-field-desc" style={{ color: 'var(--accent, #2b7cd3)' }}>
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div className="set-field-desc" style={{ color: '#ef4444' }}>
          {errorMessage}
        </div>
      )}

      {/* Cards Grid */}
      <div className="ocs-grid">
        {filteredCards.map((card) => {
          const isFav = prefs.favorites?.includes(card.id)
          const assignedApps = assignedMap.get(card.id) ?? []
          const isGlobal = prefs.globalCard === card.id
          const [bg1, bg2] = card.thumbnailColors ?? ['#18233a', '#2b3e66']
          const mediaAsset = card.mediaAssetId ? mediaMap.get(card.mediaAssetId) : undefined

          return (
            <div
              key={card.id}
              className={`ocs-card-item ${selectedCard?.id === card.id ? 'selected' : ''}`}
              onClick={() => setSelectedCard(card)}
            >
              {/* Thumbnail: Real image thumbnail or dynamic gradient */}
              <div
                className="ocs-thumb-box"
                style={{
                  background: mediaAsset?.thumbnailUrl
                    ? 'transparent'
                    : `linear-gradient(145deg, ${bg1} 0%, ${bg2} 100%)`,
                }}
              >
                {mediaAsset?.thumbnailUrl ? (
                  <img
                    src={mediaAsset.thumbnailUrl}
                    alt={card.name}
                    className="ocs-thumb-img"
                    loading="lazy"
                  />
                ) : card.contentKind === 'ai-html' ? (
                  <div className="ocs-thumb-badge ocs-badge-html">AI HTML</div>
                ) : card.mediaAssetId ? (
                  <div className="ocs-thumb-placeholder">🖼️ {card.name}</div>
                ) : (
                  <div className="ocs-thumb-badge">{card.category === 'canvas' ? '✨' : '✦'}</div>
                )}

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
                  {card.contentKind === 'ai-html' && (
                    <span className="ocs-assigned-tag ocs-badge-html">HTML</span>
                  )}
                  {isGlobal && (
                    <span
                      className="ocs-assigned-tag"
                      style={{ background: 'var(--ocs-accent)', color: 'var(--ocs-accent-ink)' }}
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
            {customizerCardIsHtml
              ? isVi
                ? `Tùy biến thẻ HTML "${selectedCard.name}"`
                : `Customize HTML Card "${selectedCard.name}"`
              : isVi
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

              {customizerCardIsHtml ? (
                <div className="ocs-unsupported-notice">
                  {isVi
                    ? '✦ Thẻ HTML tùy biến: Bạn có thể chỉnh sửa mã nguồn HTML và CSS ở khung bên phải.'
                    : '✦ Custom HTML Card: You can edit the original HTML and CSS source in the right pane.'}
                </div>
              ) : (
                <>
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
                    <label className="ocs-form-label">
                      {isVi ? 'Độ mờ (Blur)' : 'Blur Intensity'}
                    </label>
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
                </>
              )}

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

            {/* Live Interactive Preview */}
            <div className="ocs-preview-box">
              {customizerCardIsHtml ? (
                <div style={{ width: '100%' }}>
                  <div className="ocs-code-tabs">
                    <button
                      type="button"
                      className={`ocs-code-tab ${customizerTab === 'preview' ? 'active' : ''}`}
                      onClick={() => setCustomizerTab('preview')}
                    >
                      {isVi ? 'Xem thử' : 'Preview'}
                    </button>
                    <button
                      type="button"
                      className={`ocs-code-tab ${customizerTab === 'html' ? 'active' : ''}`}
                      onClick={() => setCustomizerTab('html')}
                    >
                      HTML
                    </button>
                    <button
                      type="button"
                      className={`ocs-code-tab ${customizerTab === 'css' ? 'active' : ''}`}
                      onClick={() => setCustomizerTab('css')}
                    >
                      CSS
                    </button>
                  </div>
                  {customizerLoading ? (
                    <div
                      style={{
                        padding: '20px',
                        textAlign: 'center',
                        color: 'var(--ocs-text-muted)',
                      }}
                    >
                      {isVi ? 'Đang tải HTML...' : 'Loading HTML asset...'}
                    </div>
                  ) : customizerTab === 'preview' ? (
                    <iframe
                      sandbox=""
                      srcDoc={customizerPreviewHtmlDoc}
                      className="ocs-iframe-preview"
                      title="Customizer HTML Preview"
                    />
                  ) : customizerTab === 'html' ? (
                    <textarea
                      className="ocs-code-editor"
                      value={customizerHtml}
                      onChange={(e) => setCustomizerHtml(e.target.value)}
                      spellCheck={false}
                    />
                  ) : (
                    <textarea
                      className="ocs-code-editor"
                      value={customizerCss}
                      onChange={(e) => setCustomizerCss(e.target.value)}
                      spellCheck={false}
                    />
                  )}
                </div>
              ) : (
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
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
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
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>
                      {editName || 'Document'}
                    </div>
                    <div style={{ fontSize: '11px', color: '#aab3c8' }}>
                      {isVi ? 'Đang chuẩn bị tài liệu...' : 'Getting document ready...'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Drag & Drop Personal Media Modal */}
      {showMediaModal && (
        <div className="ocs-panel">
          <div className="ocs-panel-title">
            {isVi ? 'Nhập ảnh nền cá nhân' : 'Import Personal Media'}
          </div>
          <div
            className={`ocs-dropzone ${dragOver ? 'dragover' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
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
                {isVi
                  ? 'Kéo thả ảnh vào đây hoặc bấm để chọn tệp'
                  : 'Drag & drop image here or click to browse'}
              </div>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--muted, #666)',
                  marginTop: '4px',
                }}
              >
                PNG, JPEG, WebP, GIF ({isVi ? 'Tối đa 10 MB' : 'Max 10 MB'})
              </div>
            </label>
          </div>
          {mediaError && (
            <div style={{ color: '#d32f2f', fontSize: '12px', marginTop: '6px' }}>{mediaError}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="button"
              className="ocs-action-btn"
              onClick={() => {
                setShowMediaModal(false)
                setMediaError('')
              }}
            >
              {isVi ? 'Đóng' : 'Close'}
            </button>
          </div>
        </div>
      )}

      {/* AI Generator Modal with Preview & Approval Workflow */}
      {showAiModal && (
        <div className="ocs-panel">
          <div className="ocs-panel-title">
            {isVi ? '✨ Bộ sinh thẻ bằng AI' : '✨ AI Card Generator'}
          </div>

          {/* AI Mode Selector */}
          <div className="ocs-mode-selector">
            <button
              type="button"
              className={`ocs-mode-btn ${aiMode === 'html' ? 'active' : ''}`}
              onClick={() => {
                setAiMode('html')
                setAiPreviewCard(null)
                setAiHtmlDraft(null)
              }}
            >
              {isVi ? '🌐 Thẻ HTML tùy biến' : '🌐 HTML Scene'}
            </button>
            <button
              type="button"
              className={`ocs-mode-btn ${aiMode === 'style' ? 'active' : ''}`}
              onClick={() => {
                setAiMode('style')
                setAiPreviewCard(null)
                setAiHtmlDraft(null)
              }}
            >
              {isVi ? '🎨 Mẫu phong cách' : '🎨 Style Preset'}
            </button>
            <button
              type="button"
              className={`ocs-mode-btn ${aiMode === 'image' ? 'active' : ''}`}
              onClick={() => {
                setAiMode('image')
                setAiPreviewCard(null)
                setAiHtmlDraft(null)
              }}
            >
              {isVi ? '🖼️ Hình nền AI' : '🖼️ AI Background'}
            </button>
          </div>

          {aiMode === 'image' && (
            <div className="ocs-unsupported-notice">
              {isVi
                ? '⚠️ Nhà cung cấp AI hiện tại chưa hỗ trợ chức năng sinh hình ảnh trực tiếp. Vui lòng chuyển sang chế độ Thẻ HTML hoặc Mẫu phong cách.'
                : '⚠️ The active AI provider does not support direct image generation. Please select HTML Scene or Style Preset mode.'}
            </div>
          )}

          <div className="ocs-form-group">
            <label className="ocs-form-label">
              {aiMode === 'html'
                ? isVi
                  ? 'Mô tả hiệu ứng & bố cục HTML (VD: Liquid Glass với viền phát sáng và hiệu ứng trượt):'
                  : 'Describe HTML scene & animation (e.g. Liquid Glass with glowing border & smooth slide):'
                : aiMode === 'image'
                  ? isVi
                    ? 'Mô tả hình nền muốn sinh (VD: Vũ trụ sâu thẳm với tinh vân tím):'
                    : 'Describe background image to generate (e.g. Deep space with violet nebula):'
                  : isVi
                    ? 'Mô tả phong cách thẻ bạn muốn (VD: Minimalist dark slate with emerald glow):'
                    : 'Describe your card brief (e.g. Minimalist dark slate with emerald glow):'}
            </label>
            <textarea
              className="ocs-search-input"
              rows={3}
              placeholder={
                aiMode === 'html'
                  ? 'e.g. Floating translucent glass card with glowing animated borders and soft backdrop'
                  : aiMode === 'image'
                    ? 'e.g. Atmospheric geometric gradient background with soft bokeh'
                    : 'e.g. Nordic ice mist with crisp cyan borders for writing'
              }
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              disabled={aiLoading}
            />
          </div>

          {aiError && (
            <div style={{ color: '#d32f2f', fontSize: '12px', marginTop: '4px' }}>{aiError}</div>
          )}

          {/* AI Generated Preview Stage */}
          {aiPreviewCard && (
            <div
              style={{
                marginTop: '12px',
                padding: '12px',
                border: '1px solid var(--ocs-border)',
                borderRadius: '8px',
                background: 'var(--ocs-bg)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '8px',
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 600 }}>
                  {isVi ? 'Xem trước thẻ AI sinh ra:' : 'AI Generated Preview:'}
                </span>
                {aiModelUsed && (
                  <span
                    style={{
                      fontSize: '10px',
                      background: 'var(--ocs-surface)',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      color: 'var(--ocs-text-muted)',
                    }}
                  >
                    Model: {aiModelUsed}
                  </span>
                )}
              </div>

              {aiMode === 'html' && aiHtmlDraft ? (
                <div>
                  <div className="ocs-code-tabs">
                    <button
                      type="button"
                      className={`ocs-code-tab ${aiSubTab === 'preview' ? 'active' : ''}`}
                      onClick={() => setAiSubTab('preview')}
                    >
                      {isVi ? 'Xem thử' : 'Preview'}
                    </button>
                    <button
                      type="button"
                      className={`ocs-code-tab ${aiSubTab === 'html' ? 'active' : ''}`}
                      onClick={() => setAiSubTab('html')}
                    >
                      HTML
                    </button>
                    <button
                      type="button"
                      className={`ocs-code-tab ${aiSubTab === 'css' ? 'active' : ''}`}
                      onClick={() => setAiSubTab('css')}
                    >
                      CSS
                    </button>
                  </div>

                  {aiSubTab === 'preview' ? (
                    <iframe
                      sandbox=""
                      srcDoc={aiPreviewHtmlDoc}
                      className="ocs-iframe-preview"
                      title="AI Card Live Preview"
                    />
                  ) : aiSubTab === 'html' ? (
                    <textarea
                      className="ocs-code-editor"
                      value={editDraftHtml}
                      onChange={(e) => setEditDraftHtml(e.target.value)}
                      spellCheck={false}
                      placeholder="<div>...</div>"
                    />
                  ) : (
                    <textarea
                      className="ocs-code-editor"
                      value={editDraftCss}
                      onChange={(e) => setEditDraftCss(e.target.value)}
                      spellCheck={false}
                      placeholder=".card { ... }"
                    />
                  )}
                </div>
              ) : (
                <div className="ocs-preview-box" style={{ height: '140px' }}>
                  <div
                    className="ocs-interactive-stage"
                    style={{
                      background:
                        aiPreviewCard.material.preset === 'solid'
                          ? `rgba(24, 27, 34, ${aiPreviewCard.material.opacity ?? 0.95})`
                          : `rgba(20, 25, 36, ${aiPreviewCard.material.opacity ?? 0.85})`,
                      backdropFilter:
                        (aiPreviewCard.material.blurPx ?? 22) > 0
                          ? `blur(${aiPreviewCard.material.blurPx}px)`
                          : 'none',
                      borderRadius: `${aiPreviewCard.material.borderRadiusPx ?? 18}px`,
                      border: `1px solid ${aiPreviewCard.material.borderColor ?? 'rgba(255, 255, 255, 0.15)'}`,
                      boxShadow: `0 14px 40px rgba(0,0,0,${(aiPreviewCard.material.shadowIntensity ?? 0.35) * 0.8})`,
                      color: '#f3f5fa',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '6px',
                          background: aiPreviewCard.material.accentColor ?? '#2b7cd3',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 'bold',
                          color: '#fff',
                        }}
                      >
                        AI
                      </div>
                      <span style={{ fontSize: '10px', color: '#aab3c8' }}>
                        {aiPreviewCard.material.preset}
                      </span>
                    </div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>{aiPreviewCard.name}</div>
                      {aiPreviewCard.description && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: '#aab3c8',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {aiPreviewCard.description}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '12px',
            }}
          >
            <div style={{ display: 'flex', gap: '8px' }}>
              {!aiPreviewCard ? (
                <>
                  <button
                    type="button"
                    className="ocs-action-btn primary"
                    disabled={aiLoading || !aiPrompt.trim() || aiMode === 'image'}
                    onClick={handleAiGenerate}
                  >
                    {aiLoading
                      ? isVi
                        ? 'Đang kết nối AI...'
                        : 'Connecting to AI model...'
                      : isVi
                        ? 'Tạo thẻ'
                        : 'Generate'}
                  </button>
                  {aiLoading && (
                    <button
                      type="button"
                      className="ocs-action-btn"
                      onClick={handleCancelAiGenerate}
                    >
                      {isVi ? 'Hủy' : 'Cancel'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ocs-action-btn primary"
                    onClick={handleApproveAiCard}
                  >
                    {isVi ? '✓ Lưu thẻ này' : '✓ Save this Card'}
                  </button>
                  <button
                    type="button"
                    className="ocs-action-btn"
                    disabled={aiLoading}
                    onClick={handleAiGenerate}
                  >
                    {isVi ? '🔄 Tạo biến thể khác' : '🔄 Regenerate'}
                  </button>
                  {aiLoading && (
                    <button
                      type="button"
                      className="ocs-action-btn"
                      onClick={handleCancelAiGenerate}
                    >
                      {isVi ? 'Hủy' : 'Cancel'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ocs-action-btn"
                    onClick={() => {
                      setAiPreviewCard(null)
                      setAiHtmlDraft(null)
                      setEditDraftHtml('')
                      setEditDraftCss('')
                    }}
                  >
                    {isVi ? 'Hủy bản này' : 'Discard'}
                  </button>
                </>
              )}
            </div>

            <button
              type="button"
              className="ocs-action-btn"
              onClick={() => {
                if (aiLoading) {
                  void handleCancelAiGenerate()
                }
                setShowAiModal(false)
                setAiPreviewCard(null)
                setAiHtmlDraft(null)
                setEditDraftHtml('')
                setEditDraftCss('')
                setAiError('')
              }}
            >
              {isVi ? 'Đóng' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
