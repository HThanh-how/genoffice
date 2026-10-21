import React, { useEffect, useRef, useState } from 'react'
import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import {
  OPENING_APPS,
  sceneMeta,
  type OpeningApp,
  type OpeningPrefs,
} from '../../../../shared/opening-scenes-meta'
import { buildMaterialCss, hexToRgb, sampleFileName } from '../../../../shared/opening-card-css'
import { runGOScene } from '../../../../shared/opening-scenes-runner'
import { Dropdown } from '@genoffice/ui'
import { assignmentStatus, pickPrimaryAction } from './studio-logic'
import { buildIsolatedHtmlHostDocument } from '../../../../shared/opening-card-html-sanitizer'

// App colors and human-readable names
export const APP_INFO: Record<
  OpeningApp,
  { nameEn: string; nameVi: string; ext: string; color: string }
> = {
  docs: { nameEn: 'Word', nameVi: 'Word', ext: '.docx', color: '#2b7cd3' },
  sheets: { nameEn: 'Excel', nameVi: 'Excel', ext: '.xlsx', color: '#107c41' },
  slides: { nameEn: 'PowerPoint', nameVi: 'PowerPoint', ext: '.pptx', color: '#d24726' },
  pdf: { nameEn: 'PDF', nameVi: 'PDF', ext: '.pdf', color: '#e03e2d' },
  markdown: { nameEn: 'Markdown', nameVi: 'Markdown', ext: '.md', color: '#3880ff' },
  html: { nameEn: 'HTML', nameVi: 'HTML', ext: '.html', color: '#e44d26' },
}

interface CardPreviewProps {
  card: OpeningCardDefinition | null
  prefs: OpeningPrefs
  lang: string
  onSetGlobal: (cardId: string) => Promise<void>
  onAssignToApp: (app: OpeningApp, cardId: string) => Promise<void>
  onResetOverride: (app: OpeningApp) => Promise<void>
  onPreviewWindow: (app: OpeningApp, cardIdOrScene: string) => void
  onOpenCustomizer: (card: OpeningCardDefinition) => void
  onDeleteCard?: (cardId: string) => Promise<void>
}

export function CardPreview({
  card,
  prefs,
  lang,
  onSetGlobal,
  onAssignToApp,
  onResetOverride,
  onPreviewWindow,
  onOpenCustomizer,
  onDeleteCard,
}: CardPreviewProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const [activeApp, setActiveApp] = useState<OpeningApp>('docs')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [htmlDoc, setHtmlDoc] = useState<string | null>(null)

  // Status computation
  const isGlobalDefault = prefs.globalCard === card?.id
  const hasAppOverride = Boolean(card && prefs.appOverrides?.[activeApp] === card.id)

  const fileName = sampleFileName(activeApp, lang)

  // HTML asset loader for ai-html and custom-html
  useEffect(() => {
    setHtmlDoc(null)
    if (!card || (card.contentKind !== 'ai-html' && card.contentKind !== 'custom-html')) {
      return
    }
    let cancelled = false
    const loadHtmlAsset = async () => {
      const api = (
        window as unknown as {
          aiOffice?: {
            readOpeningHtmlCard?: (id: string) => Promise<{ html: string; css: string } | null>
          }
        }
      ).aiOffice
      if (!card.htmlAssetId || !api?.readOpeningHtmlCard) {
        if (!cancelled) setHtmlDoc(null)
        return
      }
      try {
        const asset = await api.readOpeningHtmlCard(card.htmlAssetId)
        if (cancelled) return
        if (!asset) {
          setHtmlDoc(null)
          return
        }
        const doc = buildIsolatedHtmlHostDocument(
          asset.html,
          asset.css,
          {
            fileName,
            title: isVi ? 'Đang mở…' : 'Opening…',
            hint: isVi ? 'Đang chuẩn bị tài liệu.' : 'Getting the document ready.',
            appName: APP_INFO[activeApp].ext.toUpperCase().replace('.', ''),
            accentColor: card.material.accentColor || APP_INFO[activeApp].color,
          },
          {
            reducedMotion: Boolean(prefs.tier === 'minimal'),
            isCardLayout: true,
          },
        )
        if (!cancelled) setHtmlDoc(doc)
      } catch {
        if (!cancelled) setHtmlDoc(null)
      }
    }
    void loadHtmlAsset()
    return () => {
      cancelled = true
    }
  }, [card, activeApp, fileName, isVi, prefs.tier])

  const [mediaDataUrl, setMediaDataUrl] = useState<string | null>(null)

  // Media asset loader for personal-media
  useEffect(() => {
    setMediaDataUrl(null)
    if (!card || card.contentKind !== 'personal-media') {
      return
    }
    let cancelled = false
    const loadMediaAsset = async () => {
      const api = (
        window as unknown as {
          aiOffice?: {
            readOpeningMedia?: (id: string) => Promise<string | null>
            getOpeningEffects?: () => Promise<{
              mediaAssets?: Array<{ assetId: string; dataUrl?: string }>
            }>
          }
        }
      ).aiOffice
      if (!card.mediaAssetId) {
        if (!cancelled) setMediaDataUrl(null)
        return
      }
      try {
        if (api?.readOpeningMedia) {
          const url = await api.readOpeningMedia(card.mediaAssetId)
          if (cancelled) return
          if (url) {
            setMediaDataUrl(url)
            return
          }
        }
        if (api?.getOpeningEffects) {
          const state = await api.getOpeningEffects()
          if (cancelled) return
          const found = state?.mediaAssets?.find((a) => a.assetId === card.mediaAssetId)
          if (found?.dataUrl) {
            setMediaDataUrl(found.dataUrl)
            return
          }
        }
        if (!cancelled) setMediaDataUrl(null)
      } catch {
        if (!cancelled) setMediaDataUrl(null)
      }
    }
    void loadMediaAsset()
    return () => {
      cancelled = true
    }
  }, [card])

  // Live motion scene rendering in preview
  useEffect(() => {
    if (!card || card.contentKind !== 'canvas-scene' || !card.sceneId) return
    const canvas = canvasRef.current
    if (!canvas) return

    const appColor = APP_INFO[activeApp].color
    const { r, g, b } = hexToRgb(appColor)
    const rgb = `${r},${g},${b}`
    const lt = `${Math.min(255, r + 50)},${Math.min(255, g + 50)},${Math.min(255, b + 50)}`

    let stop: (() => void) | null = null
    try {
      const tier = prefs.tier === 'auto' ? 'lite' : prefs.tier || 'lite'
      stop = runGOScene(canvas, card.sceneId, tier, rgb, lt)
    } catch {
      // Ignored
    }

    return () => {
      if (stop) stop()
    }
  }, [card, activeApp, prefs.tier])

  if (!card) {
    return (
      <div className="ocs-preview-empty">
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M9 3v18M3 9h18" />
        </svg>
        <p className="ocs-preview-empty-text">
          {isVi
            ? 'Chọn một thẻ từ thư viện bên trái để xem thử trực tiếp'
            : 'Select a card from the library on the left to preview it live'}
        </p>
      </div>
    )
  }

  const matCss = buildMaterialCss(card.material, { appColor: APP_INFO[activeApp].color })

  const handleGlobal = async () => {
    setBusy(true)
    try {
      await onSetGlobal(card.id)
    } finally {
      setBusy(false)
    }
  }

  const handleAssign = async () => {
    setBusy(true)
    try {
      await onAssignToApp(activeApp, card.id)
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async () => {
    setBusy(true)
    try {
      await onResetOverride(activeApp)
    } finally {
      setBusy(false)
    }
  }

  const sceneBg =
    card.contentKind === 'canvas-scene' && card.sceneId
      ? (() => {
          const meta = sceneMeta(card.sceneId)
          return meta?.bg
            ? `linear-gradient(135deg, ${meta.bg[0]} 0%, ${meta.bg[1]} 100%)`
            : 'linear-gradient(135deg, #0b1226 0%, #1e3a6a 100%)'
        })()
      : undefined

  const status = assignmentStatus({
    isGlobalDefault,
    hasAppOverride,
    activeAppHasOtherOverride: Boolean(
      prefs.appOverrides?.[activeApp] && prefs.appOverrides[activeApp] !== card.id,
    ),
    overrideCount: Object.keys(prefs.appOverrides || {}).length,
  })
  const appName = isVi ? APP_INFO[activeApp].nameVi : APP_INFO[activeApp].nameEn
  const statusText = (() => {
    switch (status.kind) {
      case 'global-overridden':
        return isVi
          ? `Mặc định chung, nhưng ${appName} dùng thẻ khác`
          : `Default for all apps, but ${appName} uses another card`
      case 'global':
        return status.overrides > 0
          ? isVi
            ? `Mặc định chung (${status.overrides} ứng dụng có thẻ riêng)`
            : `Default for all apps (${status.overrides} with their own card)`
          : isVi
            ? 'Mặc định cho mọi ứng dụng'
            : 'Default for all apps'
      case 'app':
        return isVi ? `Đã gán cho ${appName}` : `Assigned to ${appName}`
      default:
        return isVi ? `Chưa gán cho ${appName}` : `Not assigned to ${appName}`
    }
  })()

  const primary = pickPrimaryAction({ isGlobalDefault, hasAppOverride })
  const globalLabel = isVi ? 'Đặt làm Mặc định chung' : 'Set as Global Default'
  const assignLabel = isVi ? `Gán cho ${appName}` : `Assign to ${appName}`

  return (
    <div className="ocs-preview-inspector">
      {/* Live WYSIWYG Stage Box */}
      <div className="ocs-wysiwyg-stage-wrapper">
        <div
          className="ocs-wysiwyg-stage-backdrop"
          style={sceneBg ? { background: sceneBg } : undefined}
        >
          {/* If motion scene, draw real canvas in background */}
          {card.contentKind === 'canvas-scene' && (
            <canvas ref={canvasRef} width={420} height={220} className="ocs-wysiwyg-canvas" />
          )}

          {/* If personal media, draw media background in stage backdrop */}
          {card.contentKind === 'personal-media' && mediaDataUrl && (
            <div
              className="ocs-wysiwyg-media-stage"
              style={{
                position: 'absolute',
                inset: 0,
                backgroundImage: `linear-gradient(rgba(0,0,0,${card.mediaDim ?? 0.25}), rgba(0,0,0,${card.mediaDim ?? 0.25})), url('${mediaDataUrl}')`,
                backgroundSize: card.mediaFit === 'center' ? 'auto' : (card.mediaFit ?? 'cover'),
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
                borderRadius: matCss.borderRadius,
              }}
            />
          )}

          {/* HTML Card Preview via sandboxed iframe */}
          {(card.contentKind === 'ai-html' || card.contentKind === 'custom-html') && htmlDoc ? (
            <iframe
              title="HTML Card Preview"
              sandbox="allow-scripts"
              srcDoc={htmlDoc}
              className="ocs-wysiwyg-html-iframe"
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                borderRadius: matCss.borderRadius,
                boxShadow: matCss.boxShadow,
              }}
            />
          ) : (
            /* Actual Card Surface */
            <div
              className="ocs-wysiwyg-card-stage"
              style={{
                background: matCss.background,
                backdropFilter: matCss.backdropFilter,
                WebkitBackdropFilter: matCss.backdropFilter,
                border: matCss.border,
                borderRadius: matCss.borderRadius,
                boxShadow: matCss.boxShadow,
                color: matCss.color,
              }}
            >
              {/* Top row */}
              <div className="ocs-wysiwyg-card-top">
                <div
                  className="ocs-wysiwyg-app-badge"
                  style={{ backgroundColor: APP_INFO[activeApp].color }}
                >
                  {APP_INFO[activeApp].ext.toUpperCase().replace('.', '')}
                </div>
                <div className="ocs-wysiwyg-doc-info">
                  <span className="ocs-wysiwyg-filename" title={fileName}>
                    {fileName}
                  </span>
                  <span className="ocs-wysiwyg-status">
                    {isVi ? 'Đang mở tài liệu…' : 'Opening document…'}
                  </span>
                </div>
                <span className="ocs-wysiwyg-close-indicator" aria-hidden="true">
                  &times;
                </span>
              </div>

              {/* Bottom Progress Bar */}
              <div className="ocs-wysiwyg-progress-container">
                <div
                  className="ocs-wysiwyg-progress-bar"
                  style={{ backgroundColor: APP_INFO[activeApp].color }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="ocs-inspector-head">
        <h3 className="ocs-inspector-name" title={card.name}>
          {card.name}
        </h3>
        {card.contentKind === 'canvas-scene' && (
          <span className="ocs-inspector-kind">{isVi ? 'Cảnh động' : 'Motion'}</span>
        )}
      </div>

      <div className="ocs-inspector-app-row">
        <span className="ocs-inspector-app-label">{isVi ? 'Xem thử trong' : 'Preview in'}</span>
        <Dropdown
          className="set-dd ocs-app-select"
          value={activeApp}
          ariaLabel={isVi ? 'Xem thử theo ứng dụng' : 'Preview for application'}
          options={OPENING_APPS.map((app) => ({
            value: app,
            label: isVi ? APP_INFO[app].nameVi : APP_INFO[app].nameEn,
          }))}
          onPick={(app) => setActiveApp(app)}
        />
      </div>

      <p
        className={`ocs-assignment-status${status.kind === 'none' ? ' is-none' : ''}`}
        role="status"
      >
        {statusText}
      </p>

      <div className="ocs-inspector-actions">
        {primary === 'global' && (
          <button
            type="button"
            className="set-btn ocs-btn-primary ocs-action-main"
            disabled={busy}
            onClick={handleGlobal}
          >
            {globalLabel}
          </button>
        )}
        {primary === 'assign' && (
          <button
            type="button"
            className="set-btn ocs-btn-primary ocs-action-main"
            disabled={busy}
            onClick={handleAssign}
          >
            {assignLabel}
          </button>
        )}

        <div className="ocs-action-secondary">
          {primary === 'global' && (
            <button
              type="button"
              className="set-btn"
              disabled={busy || hasAppOverride}
              onClick={handleAssign}
            >
              {assignLabel}
            </button>
          )}

          {hasAppOverride && (
            <button type="button" className="set-btn" disabled={busy} onClick={handleReset}>
              {isVi ? 'Xóa gán riêng' : 'Reset Override'}
            </button>
          )}

          <button
            type="button"
            className="set-btn"
            onClick={() => onPreviewWindow(activeApp, card.id)}
          >
            {isVi ? 'Xem cửa sổ thật' : 'Preview in Window'}
          </button>

          <button type="button" className="set-btn" onClick={() => onOpenCustomizer(card)}>
            {isVi ? 'Tùy chỉnh' : 'Customize'}
          </button>

          {!card.isBuiltIn && onDeleteCard && (
            <button
              type="button"
              className="set-btn ocs-btn-danger"
              disabled={busy}
              onClick={() => onDeleteCard(card.id)}
            >
              {isVi ? 'Xóa thẻ' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
