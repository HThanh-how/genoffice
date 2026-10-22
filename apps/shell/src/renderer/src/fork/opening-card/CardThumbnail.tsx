import React, { useEffect, useRef, useState } from 'react'
import type { OpeningCardDefinition, StoredMediaAsset } from '../../../../shared/opening-card-types'
import { CardSurface } from './CardSurface'
import { runGOScene } from '../../../../shared/opening-scenes-runner'
import { sceneMeta } from '../../../../shared/opening-scenes-meta'
import { buildIsolatedHtmlHostDocument } from '../../../../shared/opening-card-html-sanitizer'

// Bounded concurrency queue for canvas scene thumbnail generation
class ThumbnailRenderQueue {
  private active = 0
  private maxConcurrency = 4
  private queue: Array<() => Promise<void>> = []

  enqueue(task: (isCancelled: () => boolean) => Promise<void>): () => void {
    let cancelled = false
    const checkCancelled = () => cancelled
    const wrappedTask = async () => {
      if (cancelled) return
      await task(checkCancelled)
    }
    this.queue.push(wrappedTask)
    this.processNext()
    return () => {
      cancelled = true
      const idx = this.queue.indexOf(wrappedTask)
      if (idx >= 0) this.queue.splice(idx, 1)
    }
  }

  private processNext() {
    if (this.active >= this.maxConcurrency || this.queue.length === 0) return
    const next = this.queue.shift()
    if (!next) return
    this.active++
    next().finally(() => {
      this.active--
      this.processNext()
    })
  }
}

const thumbnailQueue = new ThumbnailRenderQueue()
const sceneThumbnailCache = new Map<string, string>()
const htmlThumbnailCache = new Map<string, { html: string; css: string }>()

function setBoundedCache<K, V>(map: Map<K, V>, key: K, value: V, maxSize = 60): void {
  if (map.size >= maxSize) {
    const firstKey = map.keys().next().value
    if (firstKey !== undefined) map.delete(firstKey)
  }
  map.set(key, value)
}

interface CardThumbnailProps {
  card: OpeningCardDefinition
  isVi?: boolean
  mediaAssets?: StoredMediaAsset[]
}

export function CardThumbnail({ card, isVi, mediaAssets }: CardThumbnailProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cacheKey = card.id || card.sceneId || ''
  const [cachedDataUrl, setCachedDataUrl] = useState<string | null>(() => {
    if (cacheKey && sceneThumbnailCache.has(cacheKey)) {
      return sceneThumbnailCache.get(cacheKey)!
    }
    return null
  })
  const [mediaError, setMediaError] = useState(false)
  const [htmlDoc, setHtmlDoc] = useState<string | null>(() => {
    if (
      (card.contentKind === 'ai-html' || card.contentKind === 'custom-html') &&
      card.htmlAssetId
    ) {
      const cached = htmlThumbnailCache.get(card.htmlAssetId)
      if (cached) {
        return buildIsolatedHtmlHostDocument(
          cached.html,
          cached.css,
          {
            fileName: 'Sample.docx',
            title: card.name,
            hint: 'Opening…',
            appName: 'W',
            accentColor: card.material?.accentColor || '#2b7cd3',
          },
          { reducedMotion: true, isCardLayout: true },
        )
      }
    }
    return null
  })

  const [loadedMediaUrl, setLoadedMediaUrl] = useState<string | null>(null)

  // Load personal media data URL if not available in mediaAssets prop
  useEffect(() => {
    setMediaError(false)
    if (card.contentKind !== 'personal-media' || !card.mediaAssetId) {
      setLoadedMediaUrl(null)
      return
    }
    const fromProps = mediaAssets?.find((m) => m.assetId === card.mediaAssetId)
    if (fromProps?.thumbnailUrl || fromProps?.dataUrl) {
      setLoadedMediaUrl(fromProps.thumbnailUrl || fromProps.dataUrl || null)
      return
    }
    let cancelled = false
    const api = (
      window as unknown as {
        aiOffice?: {
          readOpeningMedia?: (id: string) => Promise<string | null>
        }
      }
    ).aiOffice
    if (api?.readOpeningMedia) {
      void api
        .readOpeningMedia(card.mediaAssetId)
        .then((url) => {
          if (!cancelled && url) {
            setLoadedMediaUrl(url)
          } else if (!cancelled && !url) {
            setMediaError(true)
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.warn('[CardThumbnail] Failed to read media asset:', err)
            setMediaError(true)
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [card.contentKind, card.mediaAssetId, mediaAssets])

  // Render canvas-scene frame to canvas with bounded concurrency
  useEffect(() => {
    if (card.contentKind !== 'canvas-scene' || !card.sceneId) return
    if (cachedDataUrl) return

    const sceneId = card.sceneId
    const sceneKey = card.id || sceneId
    if (sceneThumbnailCache.has(sceneKey)) {
      setCachedDataUrl(sceneThumbnailCache.get(sceneKey)!)
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    let stop: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let isMounted = true
    let resolveTask: (() => void) | null = null

    const cancelQueue = thumbnailQueue.enqueue(async (isCancelled) => {
      if (!isMounted || isCancelled()) return
      return new Promise<void>((resolve) => {
        resolveTask = resolve
        try {
          stop = runGOScene(canvas, sceneId, 'lite', '43,124,211', '138,183,233')
          timer = setTimeout(
            () => {
              if (isMounted && !isCancelled()) {
                try {
                  const url = canvas.toDataURL('image/png')
                  if (url && url.length > 50) {
                    setBoundedCache(sceneThumbnailCache, sceneKey, url)
                    setCachedDataUrl(url)
                  }
                } catch {
                  // Canvas tainted or read failed; fallback is fine
                }
              }
              if (stop) {
                stop()
                stop = null
              }
              resolve()
              resolveTask = null
            },
            sceneMeta(sceneId)?.thumbMs ?? 100,
          )
        } catch {
          if (stop) {
            stop()
            stop = null
          }
          resolve()
          resolveTask = null
        }
      })
    })

    return () => {
      isMounted = false
      cancelQueue()
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (stop) {
        stop()
        stop = null
      }
      if (resolveTask) {
        resolveTask()
        resolveTask = null
      }
    }
  }, [card.contentKind, card.sceneId, card.id, cachedDataUrl])

  // Load HTML asset preview for AI HTML cards
  useEffect(() => {
    let cancelled = false
    if (
      (card.contentKind === 'ai-html' || card.contentKind === 'custom-html') &&
      card.htmlAssetId
    ) {
      const assetId = card.htmlAssetId
      const cached = htmlThumbnailCache.get(assetId)
      if (cached) {
        setHtmlDoc(
          buildIsolatedHtmlHostDocument(
            cached.html,
            cached.css,
            {
              fileName: 'Sample.docx',
              title: card.name,
              hint: 'Opening…',
              appName: 'W',
              accentColor: card.material?.accentColor || '#2b7cd3',
            },
            { reducedMotion: true, isCardLayout: true },
          ),
        )
        return
      }

      setHtmlDoc(null)

      const api = (
        window as unknown as {
          aiOffice?: {
            readOpeningHtmlCard?: (id: string) => Promise<{ html: string; css: string } | null>
          }
        }
      ).aiOffice
      if (api?.readOpeningHtmlCard) {
        api
          .readOpeningHtmlCard(assetId)
          .then((asset) => {
            if (!cancelled && asset?.html) {
              setBoundedCache(htmlThumbnailCache, assetId, asset)
              setHtmlDoc(
                buildIsolatedHtmlHostDocument(
                  asset.html,
                  asset.css,
                  {
                    fileName: 'Sample.docx',
                    title: card.name,
                    hint: 'Opening…',
                    appName: 'W',
                    accentColor: card.material?.accentColor || '#2b7cd3',
                  },
                  { reducedMotion: true, isCardLayout: true },
                ),
              )
            }
          })
          .catch(() => {})
      }
    } else {
      setHtmlDoc(null)
    }
    return () => {
      cancelled = true
    }
  }, [card.contentKind, card.htmlAssetId, card.name, card.material?.accentColor])

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
      </div>
    )
  }

  // 2. Material card: the very same surface as the large preview, drawn small
  if (
    card.contentKind === 'curated-material' ||
    card.contentKind === 'ai-declarative' ||
    (!card.contentKind && card.material)
  ) {
    return (
      <div className="ocs-thumb-box ocs-thumb-material">
        <CardSurface
          material={card.material}
          app="docs"
          lang={isVi ? 'vi' : 'en'}
          title={isVi ? 'Đang mở tài liệu…' : 'Opening document…'}
          decorative
          zoom={1.4}
        />
      </div>
    )
  }

  // 3. Personal media thumbnail
  if (card.contentKind === 'personal-media') {
    const mediaAsset = card.mediaAssetId
      ? mediaAssets?.find((m) => m.assetId === card.mediaAssetId)
      : undefined
    const thumbSrc = loadedMediaUrl || mediaAsset?.thumbnailUrl || mediaAsset?.dataUrl

    return (
      <div
        className="ocs-thumb-box ocs-thumb-media"
        style={{
          background: card.thumbnailColors
            ? `linear-gradient(135deg, ${card.thumbnailColors[0]} 0%, ${card.thumbnailColors[1]} 100%)`
            : 'linear-gradient(135deg, #182848 0%, #4b6cb7 100%)',
        }}
      >
        {thumbSrc && !mediaError ? (
          <img
            src={thumbSrc}
            alt={card.name}
            className="ocs-thumb-media-img"
            onError={() => setMediaError(true)}
          />
        ) : (
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
        )}
      </div>
    )
  }

  // 4. AI HTML or Custom HTML thumbnail
  return (
    <div
      className="ocs-thumb-box ocs-thumb-html"
      style={{
        background: card.thumbnailColors
          ? `linear-gradient(135deg, ${card.thumbnailColors[0]} 0%, ${card.thumbnailColors[1]} 100%)`
          : 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
      }}
    >
      {htmlDoc ? (
        <div className="ocs-thumb-html-stage">
          <iframe
            srcDoc={htmlDoc}
            title={card.name}
            sandbox="allow-same-origin"
            tabIndex={-1}
            aria-hidden="true"
            className="ocs-thumb-html-iframe"
          />
        </div>
      ) : (
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
      )}
    </div>
  )
}
