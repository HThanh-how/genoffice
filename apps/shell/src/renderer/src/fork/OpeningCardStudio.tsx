import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { OpeningEffectsState } from '../../../shared/home-api'
import {
  DEFAULT_SCENE_FOR_APP,
  MAX_OPENING_GROUPS,
  OPENING_APPS,
  type OpeningApp,
  type OpeningPrefs,
  type OpeningRandomPool,
} from '../../../shared/opening-scenes-meta'
import type { OpeningCardDefinition } from '../../../shared/opening-card-types'
import { getAllBuiltInCards } from '../../../shared/opening-card-families'
import { visibleGroupIds } from '../../../shared/opening-card-groups'
import type { SplashTier } from '../../../shared/opening-page'
import { appName as appLabelOf } from './opening-card/AppMarks'
import { CardGallery, DETAIL_PANEL_ID } from './opening-card/CardGallery'
import { CardPreview } from './opening-card/CardPreview'
import { RandomPanel } from './opening-card/RandomPanel'
import { appsUsingCard, effectiveCardId, type ApplyScope } from './opening-card/studio-logic'
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

/** The random settings without the one for this app (a card chosen for the app replaces it). */
function withoutRandom(random: OpeningPrefs['random'], app: OpeningApp): OpeningPrefs['random'] {
  if (!random?.[app]) return random
  const rest = { ...random }
  delete rest[app]
  return Object.keys(rest).length > 0 ? rest : undefined
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

  // The card whose details are open (under its row in the gallery). None until one is clicked.
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const toggleCard = (card: OpeningCardDefinition) =>
    setOpenCardId((current) => (current === card.id ? null : card.id))

  // How rich the preview is: the person's choice, or what the opening window would pick here
  const tier: SplashTier = prefs.tier === 'auto' ? (state.machineTier ?? 'lite') : prefs.tier

  // Modals state
  const [customizingCard, setCustomizingCard] = useState<OpeningCardDefinition | null>(null)
  const [showAiModal, setShowAiModal] = useState(false)
  const [showMediaModal, setShowMediaModal] = useState(false)

  // Floating notifications
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const importFileInputRef = useRef<HTMLInputElement | null>(null)

  // "More actions" menu: closes on outside click or Escape
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

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
    // "All apps" means every app: the apps' own choices give way to it
    const nextScenes = { ...prefs.scenes }
    for (const app of OPENING_APPS) nextScenes[app] = cardId
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      globalCard: cardId,
      appOverrides: undefined,
      random: undefined,
      scenes: nextScenes,
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
      random: withoutRandom(prefs.random, app),
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
      random: withoutRandom(prefs.random, app),
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

  /** Save new settings; `done` is said when they were kept. */
  const savePrefs = async (nextPrefs: OpeningPrefs, done?: string): Promise<boolean> => {
    try {
      const nextState = await api.setOpeningPrefs?.(nextPrefs)
      if (!nextState) {
        showError(isVi ? 'Không thể lưu cài đặt.' : 'Could not save the settings.')
        return false
      }
      onUpdateState(nextState)
      if (done) showStatus(done)
      return true
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  // Remove: to the trash, never gone at once. A card some app played gives way to the default.
  const handleRemoveCard = async (card: OpeningCardDefinition) => {
    const affected = appsUsingCard(prefs, card.id)
    const nextOverrides = { ...(prefs.appOverrides || {}) }
    const nextScenes = { ...prefs.scenes }
    for (const app of OPENING_APPS) {
      if (nextOverrides[app] === card.id) delete nextOverrides[app]
      if (nextScenes[app] === card.id) nextScenes[app] = DEFAULT_SCENE_FOR_APP[app]
    }
    const nextPrefs: OpeningPrefs = {
      ...prefs,
      removedCards: [...(prefs.removedCards ?? []), card.id],
      globalCard: prefs.globalCard === card.id ? undefined : prefs.globalCard,
      appOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      scenes: nextScenes,
    }
    const names = affected.map((app) => appLabelOf(app, isVi)).join(', ')
    const ok = await savePrefs(
      nextPrefs,
      affected.length > 0
        ? isVi
          ? `Đã chuyển vào thùng rác. ${names} quay về thẻ mặc định.`
          : `Moved to the trash. ${names} now ${affected.length === 1 ? 'uses' : 'use'} the default card.`
        : isVi
          ? 'Đã chuyển vào thùng rác.'
          : 'Moved to the trash.',
    )
    if (ok) setOpenCardId((current) => (current === card.id ? null : current))
  }

  const handleRestoreCard = (card: OpeningCardDefinition) =>
    savePrefs(
      {
        ...prefs,
        removedCards: (prefs.removedCards ?? []).filter((id) => id !== card.id),
      },
      isVi ? 'Đã khôi phục thẻ.' : 'Card restored.',
    )

  // Empty the trash: the cards the person made are deleted for good, built-in ones stay restorable
  const handleEmptyTrash = async () => {
    const mine = allCards.filter((c) => !c.isBuiltIn && prefs.removedCards?.includes(c.id))
    try {
      let latest: OpeningEffectsState | undefined
      for (const card of mine) latest = (await api.deleteOpeningCard?.(card.id)) ?? latest
      if (latest) onUpdateState(latest)
      showStatus(
        isVi
          ? `Đã xóa vĩnh viễn ${mine.length} thẻ của bạn.`
          : `Deleted ${mine.length} of your own ${mine.length === 1 ? 'card' : 'cards'} for good.`,
      )
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCreateGroup = (name: string) => {
    if ((prefs.groups?.length ?? 0) >= MAX_OPENING_GROUPS) {
      showError(isVi ? 'Đã đạt số nhóm tối đa.' : 'That is the most groups there can be.')
      return
    }
    const id = `grp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    void savePrefs({ ...prefs, groups: [...(prefs.groups ?? []), { id, name }] })
  }

  const handleRenameGroup = (id: string, name: string) =>
    savePrefs({
      ...prefs,
      groups: (prefs.groups ?? []).map((g) => (g.id === id ? { ...g, name } : g)),
    })

  const handleDeleteGroup = (id: string) => {
    const cardGroups = Object.fromEntries(
      Object.entries(prefs.cardGroups ?? {}).filter(([, group]) => group !== id),
    )
    const groups = (prefs.groups ?? []).filter((g) => g.id !== id)
    const random = prefs.random
      ? (Object.fromEntries(
          Object.entries(prefs.random).map(([scope, pool]) => [
            scope,
            { ...pool, groups: pool.groups.filter((g) => g !== id) },
          ]),
        ) as OpeningPrefs['random'])
      : undefined
    return savePrefs({
      ...prefs,
      groups: groups.length > 0 ? groups : undefined,
      cardGroups: Object.keys(cardGroups).length > 0 ? cardGroups : undefined,
      random,
    })
  }

  const handleMoveToGroup = (cardId: string, groupId: string | null) => {
    const cardGroups = { ...(prefs.cardGroups ?? {}) }
    if (groupId) cardGroups[cardId] = groupId
    else delete cardGroups[cardId]
    return savePrefs({
      ...prefs,
      cardGroups: Object.keys(cardGroups).length > 0 ? cardGroups : undefined,
    })
  }

  // Random mode for a target: on with a pool, or off (null)
  const handleSetRandom = (scope: ApplyScope, pool: OpeningRandomPool | null) => {
    const random: NonNullable<OpeningPrefs['random']> = { ...(prefs.random ?? {}) }
    let appOverrides = { ...(prefs.appOverrides ?? {}) }
    if (pool) {
      if (scope === 'all') {
        // every app, replacing what the apps chose for themselves
        for (const app of OPENING_APPS) delete random[app]
        appOverrides = {}
      } else {
        delete appOverrides[scope]
      }
      random[scope] = pool
    } else if (scope === 'all') {
      for (const key of ['all', ...OPENING_APPS] as ApplyScope[]) delete random[key]
    } else {
      delete random[scope]
      // still drawing because of the setting for all apps: this app gets a fixed card of its own
      if (random.all) appOverrides[scope] = effectiveCardId(prefs, scope)
    }
    return savePrefs({
      ...prefs,
      random: Object.keys(random).length > 0 ? random : undefined,
      appOverrides: Object.keys(appOverrides).length > 0 ? appOverrides : undefined,
    })
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
          setOpenCardId(customCard.id)
          showStatus(isVi ? 'Đã lưu thẻ tùy chỉnh!' : 'Custom card saved!')
          return
        }
        throw new Error(res?.error || 'Failed to save HTML card')
      }

      const res = await api.saveOpeningCard?.(customCard)
      if (res) {
        onUpdateState(res)
        setOpenCardId(customCard.id)
        showStatus(isVi ? 'Đã lưu thẻ tùy chỉnh!' : 'Custom card saved!')
      } else {
        throw new Error(isVi ? 'Không thể lưu thẻ tùy chỉnh' : 'Failed to save custom card')
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
      let savedState: OpeningEffectsState | null = null
      let saveError: unknown = null
      try {
        savedState = (await api.saveOpeningCard?.(newCard)) || null
      } catch (err) {
        saveError = err
      }

      if (savedState) {
        onUpdateState(savedState)
        setOpenCardId(newCard.id)
        showStatus(
          isVi
            ? 'Đã nhập hình ảnh và tạo thẻ thành công!'
            : 'Media imported and card created successfully!',
        )
      } else {
        // Rollback: delete the newly imported media asset since card persistence failed
        const assetId =
          (result.asset as unknown as { assetId?: string; id?: string }).assetId ||
          (result.asset as unknown as { id?: string }).id
        if (assetId && api.deleteOpeningMedia) {
          try {
            const rollbackRes = await api.deleteOpeningMedia(assetId)
            if (rollbackRes?.state) {
              onUpdateState(rollbackRes.state)
            }
          } catch {
            // best-effort cleanup; preserve original persistence error
          }
        } else if (result.state) {
          onUpdateState(result.state)
        }
        if (saveError) {
          throw saveError
        }
        throw new Error(
          isVi ? 'Không thể lưu thẻ sau khi tải ảnh' : 'Failed to save card after uploading media',
        )
      }
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
      {/* Studio Header: title, one primary action, the rest in a menu */}
      <div className="ocs-studio-header">
        <div className="ocs-studio-title-group">
          <h2 className="ocs-studio-title">{isVi ? 'Thẻ mở tệp' : 'Opening cards'}</h2>
        </div>

        <div className="ocs-studio-header-actions">
          <button type="button" className="set-btn" onClick={() => setShowAiModal(true)}>
            {isVi ? 'Tạo bằng AI' : 'Create with AI'}
          </button>

          <div className="ocs-more" ref={menuRef}>
            <button
              type="button"
              className="set-btn ocs-more-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={isVi ? 'Thêm thao tác' : 'More actions'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="3" cy="8" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="13" cy="8" r="1.3" />
              </svg>
            </button>
            {menuOpen && (
              <div className="ocs-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowMediaModal(true)
                  }}
                >
                  {isVi ? 'Thêm hình ảnh…' : 'Add media…'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  title={isVi ? 'Xuất danh sách thẻ ra tệp JSON' : 'Export cards to JSON file'}
                  onClick={() => {
                    setMenuOpen(false)
                    void handleExport()
                  }}
                >
                  {isVi ? 'Xuất thẻ' : 'Export'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  title={isVi ? 'Nhập thẻ từ tệp JSON' : 'Import cards from JSON file'}
                  onClick={() => {
                    setMenuOpen(false)
                    importFileInputRef.current?.click()
                  }}
                >
                  {isVi ? 'Nhập thẻ' : 'Import'}
                </button>
              </div>
            )}
          </div>
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

      {/* The details of a card open right under its row when it is clicked, and scroll with the list */}
      <div className="ocs-studio-layout">
        <RandomPanel
          cards={allCards.filter((c) => !prefs.removedCards?.includes(c.id))}
          prefs={prefs}
          lang={lang}
          groupIds={visibleGroupIds(allCards, prefs)}
          onChange={handleSetRandom}
        />
        <div className="ocs-layout-left">
          <CardGallery
            cards={allCards}
            openCardId={openCardId}
            prefs={prefs}
            lang={lang}
            mediaAssets={state.mediaAssets}
            onToggleCard={toggleCard}
            onCloseDetail={() => setOpenCardId(null)}
            onToggleFavorite={handleToggleFavorite}
            onRemoveCard={handleRemoveCard}
            onRestoreCard={handleRestoreCard}
            onEmptyTrash={handleEmptyTrash}
            onCreateGroup={handleCreateGroup}
            onRenameGroup={handleRenameGroup}
            onDeleteGroup={handleDeleteGroup}
            renderDetail={(card) => (
              <CardPreview
                key={card.id}
                card={card}
                prefs={prefs}
                lang={lang}
                tier={tier}
                panelId={DETAIL_PANEL_ID}
                onClose={() => setOpenCardId(null)}
                onSetGlobal={handleSetGlobal}
                onAssignToApp={handleAssignToApp}
                onResetOverride={handleResetOverride}
                onPreviewWindow={onPreview}
                onOpenCustomizer={setCustomizingCard}
                onRemoveCard={handleRemoveCard}
                onMoveToGroup={handleMoveToGroup}
              />
            )}
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
