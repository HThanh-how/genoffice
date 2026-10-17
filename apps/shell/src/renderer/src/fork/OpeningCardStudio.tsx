import React, { useMemo, useRef, useState } from 'react'
import type { OpeningEffectsState } from '../../../shared/home-api'
import {
  DEFAULT_SCENE_FOR_APP,
  type OpeningApp,
  type OpeningPrefs,
} from '../../../shared/opening-scenes-meta'
import type { OpeningCardDefinition } from '../../../shared/opening-card-types'
import { getAllBuiltInCards } from '../../../shared/opening-card-families'
import { CardGallery } from './opening-card/CardGallery'
import { CardPreview } from './opening-card/CardPreview'
import { CardCustomizer } from './opening-card/CardCustomizer'
import { AiCardModal } from './opening-card/AiCardModal'
import { MediaImportModal } from './opening-card/MediaImportModal'
import './opening-card-studio.css'

interface StudioProps {
  state: OpeningEffectsState
  lang: string
  onUpdateState: (next: OpeningEffectsState) => void
  onPreview: (app: OpeningApp, sceneOrCard: string) => void
}

export function OpeningCardStudio({
  state,
  lang,
  onUpdateState,
  onPreview,
}: StudioProps): React.JSX.Element {
  const api = window.aiOffice
  const { prefs } = state
  const isVi = lang === 'vi'

  // Combine built-in cards and custom cards
  const allCards = useMemo(() => {
    const builtIn = state.builtInCards?.length ? state.builtInCards : getAllBuiltInCards()
    const custom = prefs.customCards || []
    return [...builtIn, ...custom]
  }, [state.builtInCards, prefs.customCards])

  // Initial selected card
  const [selectedCard, setSelectedCard] = useState<OpeningCardDefinition | null>(() => {
    const defaultId =
      prefs.globalCard || state.effectiveScenes?.docs?.id || DEFAULT_SCENE_FOR_APP.docs
    return allCards.find((c) => c.id === defaultId) || allCards[0] || null
  })

  // Modals state
  const [customizingCard, setCustomizingCard] = useState<OpeningCardDefinition | null>(null)
  const [showAiModal, setShowAiModal] = useState(false)
  const [showMediaModal, setShowMediaModal] = useState(false)

  // Floating notifications
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const importFileInputRef = useRef<HTMLInputElement | null>(null)

  const showStatus = (msg: string) => {
    setStatusMessage(msg)
    setErrorMessage('')
    setTimeout(() => setStatusMessage(''), 3500)
  }

  const showError = (msg: string) => {
    setErrorMessage(msg)
    setStatusMessage('')
  }

  // Action handlers
  const handleToggleFavorite = async (cardId: string) => {
    try {
      const nextState = await api.toggleOpeningFavorite?.(cardId)
      if (nextState) {
        onUpdateState(nextState)
      } else {
        showError(isVi ? 'Không thể cập nhật yêu thích.' : 'Failed to update favorite.')
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSetGlobal = async (cardId: string) => {
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      globalCard: cardId,
    }
    try {
      const nextState = await api.setOpeningPrefs?.(nextPrefs)
      if (nextState) {
        onUpdateState(nextState)
        showStatus(
          isVi
            ? 'Đã đặt làm Mặc định chung cho tất cả ứng dụng!'
            : 'Set as Global Default for all applications!',
        )
      } else {
        showError(isVi ? 'Không thể lưu cài đặt chung.' : 'Failed to save global setting.')
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    }
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
      if (nextState) {
        onUpdateState(nextState)
        showStatus(
          isVi
            ? `Đã gán thẻ thành công cho ${app.toUpperCase()}`
            : `Assigned card successfully to ${app.toUpperCase()}`,
        )
      } else {
        showError(
          isVi
            ? `Không thể gán thẻ cho ${app.toUpperCase()}`
            : `Failed to assign card to ${app.toUpperCase()}`,
        )
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
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
      if (nextState) {
        onUpdateState(nextState)
        showStatus(
          isVi
            ? `Đã xóa cấu hình riêng của ${app.toUpperCase()}`
            : `Reset override for ${app.toUpperCase()}`,
        )
      } else {
        showError(
          isVi
            ? `Không thể xóa cấu hình riêng của ${app.toUpperCase()}`
            : `Failed to reset override for ${app.toUpperCase()}`,
        )
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeleteCard = async (cardId: string) => {
    try {
      const nextState = await api.deleteOpeningCard?.(cardId)
      if (nextState) {
        onUpdateState(nextState)
        if (selectedCard?.id === cardId) {
          setSelectedCard(allCards.find((c) => c.id !== cardId) || null)
        }
        showStatus(isVi ? 'Đã xóa thẻ tùy chỉnh.' : 'Custom card deleted.')
      } else {
        showError(isVi ? 'Không thể xóa thẻ này.' : 'Failed to delete card.')
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveCustomCard = async (
    customCard: OpeningCardDefinition,
    htmlAsset?: { html: string; css: string },
  ) => {
    try {
      if (htmlAsset && api.saveOpeningHtmlCard) {
        const res = await api.saveOpeningHtmlCard({
          card: customCard,
          html: htmlAsset.html,
          css: htmlAsset.css,
        })
        if (res?.ok) {
          onUpdateState(res.state)
          setSelectedCard(
            res.state.prefs.customCards?.find((card) => card.id === customCard.id) ?? customCard,
          )
          showStatus(isVi ? 'Đã lưu thẻ tùy chỉnh!' : 'Custom card saved!')
          return
        }
        throw new Error(res?.error || 'Failed to save HTML card')
      }

      const res = await api.saveOpeningCard?.(customCard)
      if (res) {
        onUpdateState(res)
        setSelectedCard(customCard)
        showStatus(isVi ? 'Đã lưu thẻ tùy chỉnh!' : 'Custom card saved!')
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  const handleImportMedia = async (file: File) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const res = reader.result as string
        const comma = res.indexOf(',')
        resolve(comma >= 0 ? res.slice(comma + 1) : res)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    const result = await api.importOpeningMedia?.(base64, file.name)
    if (result?.ok && result.asset) {
      const cardName = (
        file.name.replace(/\.[^.]+$/, '').trim() || (isVi ? 'Hình ảnh riêng' : 'Personal Media')
      ).slice(0, 60)
      const newCard: OpeningCardDefinition = {
        id: `custom:media_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        name: cardName,
        category: 'media',
        contentKind: 'personal-media',
        mediaAssetId:
          (result.asset as unknown as { assetId?: string; id?: string }).assetId ||
          (result.asset as unknown as { id?: string }).id,
        mediaFit: 'cover',
        mediaDim: 0.25,
        material: {
          preset: 'frosted-glass',
          opacity: 0.85,
          blurPx: 16,
          accentColor: '#2b7cd3',
          borderRadiusPx: 14,
        },
        createdAt: Date.now(),
      }
      const savedState = await api.saveOpeningCard?.(newCard)
      if (savedState) {
        onUpdateState(savedState)
        setSelectedCard(newCard)
      } else if (result.state) {
        onUpdateState(result.state)
      }
      showStatus(
        isVi
          ? 'Đã nhập hình ảnh và tạo thẻ thành công!'
          : 'Media imported and card created successfully!',
      )
    } else {
      throw new Error(result?.error || 'Failed to import media')
    }
  }

  const handleExport = async () => {
    try {
      const json = await api.exportOpeningCards?.()
      if (!json) return
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `genoffice-opening-cards-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      showStatus(isVi ? 'Đã xuất danh sách thẻ!' : 'Exported cards JSON!')
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const res = await api.importOpeningCards?.(text)
      if (res?.ok) {
        const next = await api.getOpeningEffects?.()
        if (next) onUpdateState(next)
        showStatus(
          isVi
            ? `Đã nhập thành công ${res.count} thẻ!`
            : `Successfully imported ${res.count} cards!`,
        )
      } else {
        showError(res?.error || (isVi ? 'Nhập thẻ thất bại' : 'Failed to import cards'))
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      if (importFileInputRef.current) importFileInputRef.current.value = ''
    }
  }

  return (
    <div className="ocs-container">
      {/* Studio Header Toolbar */}
      <div className="ocs-studio-header">
        <div className="ocs-studio-title-group">
          <h2 className="ocs-studio-title">
            {isVi ? 'Studio Thẻ Mở Tệp V2' : 'Opening Card Studio V2'}
          </h2>
          <span className="ocs-studio-count">
            {allCards.length} {isVi ? 'thẻ' : 'cards'}
          </span>
        </div>

        <div className="ocs-studio-header-actions">
          <button
            type="button"
            className="set-btn ocs-btn-primary"
            onClick={() => setShowAiModal(true)}
          >
            {isVi ? '✨ Thẻ AI' : '✨ AI Card'}
          </button>

          <button type="button" className="set-btn" onClick={() => setShowMediaModal(true)}>
            {isVi ? '🖼️ Thêm Media' : '🖼️ Add Media'}
          </button>

          <button
            type="button"
            className="set-btn"
            onClick={handleExport}
            title={isVi ? 'Xuất danh sách thẻ ra tệp JSON' : 'Export cards to JSON file'}
          >
            {isVi ? 'Xuất thẻ' : 'Export'}
          </button>

          <button
            type="button"
            className="set-btn"
            onClick={() => importFileInputRef.current?.click()}
            title={isVi ? 'Nhập thẻ từ tệp JSON' : 'Import cards from JSON file'}
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

      {/* Floating Status & Error Alerts */}
      {statusMessage && (
        <div className="ocs-floating-toast is-success" role="status">
          <span>{statusMessage}</span>
        </div>
      )}
      {errorMessage && (
        <div className="ocs-floating-toast is-error" role="alert">
          <span>{errorMessage}</span>
          <button type="button" className="ocs-toast-close" onClick={() => setErrorMessage('')}>
            &times;
          </button>
        </div>
      )}

      {/* 2-Column Master-Detail Layout */}
      <div className="ocs-studio-layout">
        {/* Left Column: Gallery */}
        <div className="ocs-layout-left">
          <CardGallery
            cards={allCards}
            selectedCard={selectedCard}
            prefs={prefs}
            lang={lang}
            mediaAssets={state.mediaAssets}
            onSelectCard={setSelectedCard}
            onToggleFavorite={handleToggleFavorite}
          />
        </div>

        {/* Right Column: Sticky WYSIWYG Inspector */}
        <div className="ocs-layout-right">
          <CardPreview
            card={selectedCard}
            prefs={prefs}
            lang={lang}
            onSetGlobal={handleSetGlobal}
            onAssignToApp={handleAssignToApp}
            onResetOverride={handleResetOverride}
            onPreviewWindow={onPreview}
            onOpenCustomizer={setCustomizingCard}
            onDeleteCard={handleDeleteCard}
          />
        </div>
      </div>

      {/* Modals */}
      {customizingCard && (
        <CardCustomizer
          card={customizingCard}
          lang={lang}
          onSave={handleSaveCustomCard}
          onClose={() => setCustomizingCard(null)}
        />
      )}

      {showAiModal && (
        <AiCardModal
          lang={lang}
          onSave={handleSaveCustomCard}
          onClose={() => setShowAiModal(false)}
        />
      )}

      {showMediaModal && (
        <MediaImportModal
          lang={lang}
          onImport={handleImportMedia}
          onClose={() => setShowMediaModal(false)}
        />
      )}
    </div>
  )
}
