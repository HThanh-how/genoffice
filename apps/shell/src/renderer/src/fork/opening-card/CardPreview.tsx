import React, { useEffect, useState } from 'react'
import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import { cardLabel } from '../../../../shared/opening-card-text'
import {
  OPENING_APPS,
  type OpeningApp,
  type OpeningPrefs,
} from '../../../../shared/opening-scenes-meta'
import { buildMaterialCss, sampleFileName } from '../../../../shared/opening-card-css'
import { skeletonHtml, type SplashTier } from '../../../../shared/opening-page'
import { APP_INFO } from './app-info'
import { appName as appLabelOf } from './AppMarks'
import { CardSurface } from './CardSurface'
import { OpeningPageView } from './OpeningPageView'
import { TargetSwitch } from './TargetSwitch'
import { appliesTo, appsUsingCard, type ApplyScope } from './studio-logic'
import { buildIsolatedHtmlHostDocument } from '../../../../shared/opening-card-html-sanitizer'

export { APP_INFO }

interface CardPreviewProps {
  card: OpeningCardDefinition
  prefs: OpeningPrefs
  lang: string
  /** how rich the animation is: what the opening window would use on this machine */
  tier: SplashTier
  /** id of the element that names this panel, for the grid that owns it */
  panelId?: string
  onClose: () => void
  onSetGlobal: (cardId: string) => Promise<void>
  onAssignToApp: (app: OpeningApp, cardId: string) => Promise<void>
  onResetOverride: (app: OpeningApp) => Promise<void>
  onPreviewWindow: (app: OpeningApp, cardIdOrScene: string) => void
  onOpenCustomizer: (card: OpeningCardDefinition) => void
  onDeleteCard?: (cardId: string) => Promise<void>
}

type AiOfficeApi = {
  readOpeningHtmlCard?: (id: string) => Promise<{ html: string; css: string } | null>
  readOpeningMedia?: (id: string) => Promise<string | null>
  getOpeningEffects?: () => Promise<{ mediaAssets?: Array<{ assetId: string; dataUrl?: string }> }>
}

export function CardPreview({
  card,
  prefs,
  lang,
  tier,
  panelId,
  onClose,
  onSetGlobal,
  onAssignToApp,
  onResetOverride,
  onPreviewWindow,
  onOpenCustomizer,
  onDeleteCard,
}: CardPreviewProps): React.JSX.Element {
  const isVi = lang === 'vi'
  // Where "Use this card" applies: every app, or one app. The stage previews that app (Word for "all").
  const [scope, setScope] = useState<ApplyScope>('all')
  const activeApp: OpeningApp = scope === 'all' ? 'docs' : scope
  const [busy, setBusy] = useState(false)
  const [htmlDoc, setHtmlDoc] = useState<string | null>(null)
  const [mediaDataUrl, setMediaDataUrl] = useState<string | null>(null)

  const applied = appliesTo(scope, prefs, card.id)
  const label = cardLabel(card, lang)
  const fileName = sampleFileName(activeApp, lang)

  // HTML asset loader for ai-html and custom-html
  useEffect(() => {
    setHtmlDoc(null)
    if (card.contentKind !== 'ai-html' && card.contentKind !== 'custom-html') return
    let cancelled = false
    const api = (window as unknown as { aiOffice?: AiOfficeApi }).aiOffice
    if (!card.htmlAssetId || !api?.readOpeningHtmlCard) return
    api
      .readOpeningHtmlCard(card.htmlAssetId)
      .then((asset) => {
        if (cancelled || !asset) return
        setHtmlDoc(
          buildIsolatedHtmlHostDocument(
            asset.html,
            asset.css,
            {
              fileName,
              title: isVi ? 'Đang mở…' : 'Opening…',
              hint: isVi ? 'Đang chuẩn bị tài liệu.' : 'Getting the document ready.',
              appName: APP_INFO[activeApp].letter,
              accentColor: card.material.accentColor || APP_INFO[activeApp].color,
            },
            {
              reducedMotion: tier === 'minimal',
              isCardLayout: true,
              skeletonHtml: skeletonHtml(activeApp),
            },
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setHtmlDoc(null)
      })
    return () => {
      cancelled = true
    }
  }, [card, activeApp, fileName, isVi, tier])

  // Media asset loader for personal-media
  useEffect(() => {
    setMediaDataUrl(null)
    if (card.contentKind !== 'personal-media' || !card.mediaAssetId) return
    let cancelled = false
    const api = (window as unknown as { aiOffice?: AiOfficeApi }).aiOffice
    const load = async () => {
      try {
        const url = await api?.readOpeningMedia?.(card.mediaAssetId!)
        if (cancelled) return
        if (url) {
          setMediaDataUrl(url)
          return
        }
        const state = await api?.getOpeningEffects?.()
        if (cancelled) return
        setMediaDataUrl(
          state?.mediaAssets?.find((a) => a.assetId === card.mediaAssetId)?.dataUrl ?? null,
        )
      } catch {
        if (!cancelled) setMediaDataUrl(null)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [card])

  const matCss = buildMaterialCss(card.material, { appColor: APP_INFO[activeApp].color })

  const handleApply = async () => {
    setBusy(true)
    try {
      if (scope === 'all') await onSetGlobal(card.id)
      else await onAssignToApp(scope, card.id)
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

  const appLabel = (app: OpeningApp) => appLabelOf(app, isVi)
  const usedBy = appsUsingCard(prefs, card.id)
  const statusText = (() => {
    if (scope === 'all') {
      if (usedBy.length === OPENING_APPS.length) {
        return isVi ? 'Đang dùng cho mọi ứng dụng' : 'In use for all apps'
      }
      return usedBy.length > 0
        ? isVi
          ? `Đang dùng cho ${usedBy.map(appLabel).join(', ')}`
          : `In use for ${usedBy.map(appLabel).join(', ')}`
        : isVi
          ? 'Chưa dùng ở đâu'
          : 'Not in use yet'
    }
    const name = appLabel(activeApp)
    return applied
      ? isVi
        ? `Đang dùng cho ${name}`
        : `In use for ${name}`
      : isVi
        ? `${name} chưa dùng thẻ này`
        : `${name} does not use this card`
  })()
  const canReset = scope !== 'all' && prefs.appOverrides?.[activeApp] === card.id

  const kindLabel =
    card.contentKind === 'canvas-scene'
      ? isVi
        ? 'Cảnh động'
        : 'Motion'
      : card.contentKind === 'personal-media'
        ? isVi
          ? 'Hình ảnh'
          : 'Media'
        : card.contentKind === 'ai-html' || card.contentKind === 'custom-html'
          ? 'HTML'
          : isVi
            ? 'Chất liệu'
            : 'Material'

  const isSurfaceCard =
    card.contentKind === 'curated-material' || card.contentKind === 'ai-declarative'
  const isHtmlCard = card.contentKind === 'ai-html' || card.contentKind === 'custom-html'

  const stage = isSurfaceCard ? (
    <CardSurface
      material={card.material}
      app={activeApp}
      lang={lang}
      title={isVi ? 'Đang mở tài liệu…' : 'Opening document…'}
      animate
    />
  ) : isHtmlCard ? (
    <div className="ocs-wysiwyg-stage-backdrop">
      {htmlDoc ? (
        <iframe
          title="HTML Card Preview"
          sandbox="allow-scripts"
          srcDoc={htmlDoc}
          className="ocs-wysiwyg-html-iframe"
          style={{ borderRadius: matCss.borderRadius }}
        />
      ) : null}
    </div>
  ) : (
    <OpeningPageView
      app={activeApp}
      lang={lang}
      tier={tier}
      sceneId={card.sceneId}
      card={card}
      mediaDataUrl={mediaDataUrl}
    />
  )

  const useLabel = applied
    ? isVi
      ? 'Đang dùng'
      : 'In use'
    : isVi
      ? 'Dùng thẻ này'
      : 'Use this card'

  return (
    <div
      className="ocs-preview-inspector"
      role="region"
      aria-labelledby={panelId ? `${panelId}-name` : undefined}
      id={panelId}
    >
      <div className="ocs-preview-media">
        <div
          className="ocs-wysiwyg-stage-wrapper"
          role="img"
          aria-label={isVi ? `Xem thử trực tiếp: ${label.name}` : `Live preview: ${label.name}`}
        >
          {stage}
        </div>
        <div className="ocs-apply-row">
          <TargetSwitch value={scope} onChange={setScope} isVi={isVi} />
          <button
            type="button"
            className="set-btn ocs-btn-primary ocs-action-main"
            disabled={busy || applied}
            onClick={handleApply}
          >
            {useLabel}
          </button>
        </div>
      </div>

      <div className="ocs-preview-info">
        <div className="ocs-inspector-head">
          <h3
            className="ocs-inspector-name"
            id={panelId ? `${panelId}-name` : undefined}
            title={label.name}
          >
            {label.name}
          </h3>
          <span className="ocs-inspector-kind">{kindLabel}</span>
        </div>

        {label.description && label.description !== label.name && (
          <p className="ocs-inspector-desc">{label.description}</p>
        )}

        <p className="ocs-assignment-status" role="status">
          {statusText}
        </p>

        <div className="ocs-text-actions">
          <button type="button" onClick={() => onPreviewWindow(activeApp, card.id)}>
            {isVi ? 'Xem trong cửa sổ' : 'Preview in window'}
          </button>
          <button type="button" onClick={() => onOpenCustomizer(card)}>
            {isVi ? 'Tùy chỉnh' : 'Customize'}
          </button>
          {canReset && (
            <button type="button" disabled={busy} onClick={handleReset}>
              {isVi
                ? `Trả ${appLabel(activeApp)} về mặc định`
                : `Reset ${appLabel(activeApp)} to default`}
            </button>
          )}
          {!card.isBuiltIn && onDeleteCard && (
            <button
              type="button"
              className="ocs-btn-danger"
              disabled={busy}
              onClick={() => onDeleteCard(card.id)}
            >
              {isVi ? 'Xóa thẻ' : 'Delete'}
            </button>
          )}
        </div>
      </div>

      <button
        type="button"
        className="ocs-detail-close"
        aria-label={isVi ? 'Đóng chi tiết' : 'Close details'}
        title={isVi ? 'Đóng' : 'Close'}
        onClick={onClose}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}
