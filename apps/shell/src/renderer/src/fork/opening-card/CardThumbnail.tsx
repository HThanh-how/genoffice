import React, { useEffect, useRef, useState } from 'react'
import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import { buildMaterialCss } from '../../../../shared/opening-card-css'
import { runGOScene } from '../../../../shared/opening-scenes-runner'
import { sceneMeta } from '../../../../shared/opening-scenes-meta'

// Cache of rendered scene snapshots so we don't re-render canvases repeatedly
const sceneThumbnailCache = new Map<string, string>()

interface CardThumbnailProps {
  card: OpeningCardDefinition
  isVi?: boolean
}

export function CardThumbnail({ card, isVi }: CardThumbnailProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [cachedDataUrl, setCachedDataUrl] = useState<string | null>(() => {
    if (card.sceneId && sceneThumbnailCache.has(card.sceneId)) {
      return sceneThumbnailCache.get(card.sceneId)!
    }
    return null
  })

  // Render canvas-scene frame to canvas and cache snapshot
  useEffect(() => {
    if (card.contentKind !== 'canvas-scene' || !card.sceneId) return
    if (cachedDataUrl) return

    const sceneId = card.sceneId
    if (sceneThumbnailCache.has(sceneId)) {
      setCachedDataUrl(sceneThumbnailCache.get(sceneId)!)
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    let stop: (() => void) | null = null
    try {
      stop = runGOScene(canvas, sceneId, 'lite', '43,124,211', '138,183,233')
      // Allow a brief moment for scene initialization then capture snapshot
      const timer = setTimeout(() => {
        try {
          const url = canvas.toDataURL('image/png')
          if (url && url.length > 50) {
            sceneThumbnailCache.set(sceneId, url)
            setCachedDataUrl(url)
          }
        } catch {
          // Canvas tainted or read failed; fallback is fine
        }
        if (stop) stop()
      }, 120)

      return () => {
        clearTimeout(timer)
        if (stop) stop()
      }
    } catch {
      if (stop) stop()
    }
  }, [card.contentKind, card.sceneId, cachedDataUrl])

  // 1. Motion scene thumbnail
  if (card.contentKind === 'canvas-scene' && card.sceneId) {
    const meta = sceneMeta(card.sceneId)
    const bgGrad = meta?.bg
      ? `linear-gradient(135deg, ${meta.bg[0]} 0%, ${meta.bg[1]} 100%)`
      : 'linear-gradient(135deg, #0b1226 0%, #1e3a6a 100%)'

    return (
      <div className="ocs-thumb-box ocs-thumb-scene" style={{ background: bgGrad }}>
        {cachedDataUrl ? (
          <img
            src={cachedDataUrl}
            alt={isVi ? (meta?.vi ?? card.name) : (meta?.en ?? card.name)}
            className="ocs-thumb-img"
          />
        ) : (
          <canvas
            ref={canvasRef}
            width={240}
            height={135}
            className="ocs-thumb-canvas"
            style={{ width: '100%', height: '100%' }}
          />
        )}
        <div className="ocs-thumb-kind-pill">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4 3.5v9l8-4.5-8-4.5z" />
          </svg>
          <span>{isVi ? 'Động' : 'Motion'}</span>
        </div>
      </div>
    )
  }

  // 2. Curated material (or custom material) thumbnail
  if (card.contentKind === 'curated-material' || (!card.contentKind && card.material)) {
    const matCss = buildMaterialCss(card.material)
    const presetLabel =
      card.material.preset === 'frosted-glass'
        ? isVi
          ? 'Kính mờ'
          : 'Glass'
        : card.material.preset === 'liquid-glass'
          ? isVi
            ? 'Kính lỏng'
            : 'Liquid'
          : card.material.preset === 'solid'
            ? isVi
              ? 'Đặc'
              : 'Solid'
            : isVi
              ? 'Tối giản'
              : 'Mono'

    return (
      <div className="ocs-thumb-box ocs-thumb-material">
        <div className="ocs-thumb-material-backdrop">
          {/* Representative mini card surface */}
          <div
            className="ocs-thumb-mini-card"
            style={{
              background: matCss.background,
              backdropFilter: matCss.backdropFilter,
              WebkitBackdropFilter: matCss.backdropFilter,
              border: matCss.border,
              boxShadow: matCss.boxShadow,
              borderRadius: matCss.borderRadius,
            }}
          >
            <div className="ocs-thumb-mini-header">
              <span
                className="ocs-thumb-mini-dot"
                style={{ backgroundColor: matCss.accentColor }}
              />
              <div className="ocs-thumb-mini-title-bar" />
            </div>
            <div className="ocs-thumb-mini-body">
              <div className="ocs-thumb-mini-line w-80" />
              <div className="ocs-thumb-mini-line w-60" />
            </div>
          </div>
        </div>
        <div className="ocs-thumb-kind-pill">
          <span
            className="ocs-thumb-pill-dot"
            style={{ backgroundColor: card.material.accentColor ?? '#2b7cd3' }}
          />
          <span>{presetLabel}</span>
        </div>
      </div>
    )
  }

  // 3. Personal media thumbnail
  if (card.contentKind === 'personal-media') {
    return (
      <div
        className="ocs-thumb-box ocs-thumb-media"
        style={{
          background: card.thumbnailColors
            ? `linear-gradient(135deg, ${card.thumbnailColors[0]} 0%, ${card.thumbnailColors[1]} 100%)`
            : 'linear-gradient(135deg, #182848 0%, #4b6cb7 100%)',
        }}
      >
        <div className="ocs-thumb-media-center">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </div>
        <div className="ocs-thumb-kind-pill">
          <span>{isVi ? 'Ảnh/Media' : 'Media'}</span>
        </div>
      </div>
    )
  }

  // 4. AI HTML thumbnail
  return (
    <div
      className="ocs-thumb-box ocs-thumb-html"
      style={{
        background: card.thumbnailColors
          ? `linear-gradient(135deg, ${card.thumbnailColors[0]} 0%, ${card.thumbnailColors[1]} 100%)`
          : 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
      }}
    >
      <div className="ocs-thumb-html-code">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      </div>
      <div className="ocs-thumb-kind-pill">
        <span>HTML</span>
      </div>
    </div>
  )
}
