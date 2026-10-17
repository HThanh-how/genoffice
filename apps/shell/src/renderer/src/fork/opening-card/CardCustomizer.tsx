import React, { useEffect, useMemo, useState } from 'react'
import type {
  OpeningCardDefinition,
  OpeningMaterialPreset,
  OpeningThemeMode,
} from '../../../../shared/opening-card-types'
import { buildMaterialCss } from '../../../../shared/opening-card-css'
import { buildIsolatedHtmlHostDocument } from '../../../../shared/opening-card-html-sanitizer'

const COLOR_PRESETS = [
  '#2b7cd3',
  '#107c41',
  '#d24726',
  '#8e44ad',
  '#2c3e50',
  '#008080',
  '#f39c12',
  '#e74c3c',
]

interface CardCustomizerProps {
  card: OpeningCardDefinition
  lang: string
  onSave: (
    customCard: OpeningCardDefinition,
    htmlAsset?: { html: string; css: string },
  ) => Promise<void>
  onClose: () => void
}

export function CardCustomizer({
  card,
  lang,
  onSave,
  onClose,
}: CardCustomizerProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const isHtml = card.contentKind === 'ai-html'

  const [activeTab, setActiveTab] = useState<'material' | 'html'>('material')
  const [name, setName] = useState(`${card.name} (${isVi ? 'Tùy chỉnh' : 'Custom'})`.slice(0, 60))
  const [preset, setPreset] = useState<OpeningMaterialPreset>(
    card.material?.preset ?? 'frosted-glass',
  )
  const [themeMode, setThemeMode] = useState<OpeningThemeMode>(card.material?.themeMode ?? 'system')
  const [opacity, setOpacity] = useState<number>(card.material?.opacity ?? 0.85)
  const [blurPx, setBlurPx] = useState<number>(card.material?.blurPx ?? 22)
  const [borderRadiusPx, setBorderRadiusPx] = useState<number>(card.material?.borderRadiusPx ?? 18)
  const [shadowIntensity, setShadowIntensity] = useState<number>(
    card.material?.shadowIntensity ?? 0.35,
  )
  const [borderWidthPx, setBorderWidthPx] = useState<number>(card.material?.borderWidthPx ?? 1)
  const [accentColor, setAccentColor] = useState<string>(card.material?.accentColor ?? '#2b7cd3')

  // HTML / CSS state if HTML card
  const [htmlCode, setHtmlCode] = useState('')
  const [cssCode, setCssCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  // Load existing HTML / CSS asset if customizing an HTML card
  useEffect(() => {
    let cancelled = false
    if (isHtml && card.htmlAssetId) {
      const api = (
        window as unknown as {
          aiOffice?: {
            readOpeningHtmlCard?: (id: string) => Promise<{ html: string; css: string } | null>
          }
        }
      ).aiOffice
      if (api?.readOpeningHtmlCard) {
        api
          .readOpeningHtmlCard(card.htmlAssetId)
          .then((asset) => {
            if (!cancelled && asset) {
              setHtmlCode(asset.html || '')
              setCssCode(asset.css || '')
            }
          })
          .catch((err) => {
            console.error('[CardCustomizer] Failed to read HTML asset:', err)
          })
      }
    }
    return () => {
      cancelled = true
    }
  }, [isHtml, card.htmlAssetId])

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Handle Escape key with capture phase to prevent bubbling to parent SettingsModal
  useEffect(() => {
    const previousActive = document.activeElement as HTMLElement | null
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.stopImmediatePropagation()
        e.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      previousActive?.focus?.()
    }
  }, [])

  const liveHtmlDoc = useMemo(() => {
    if (!isHtml || (!htmlCode && !cssCode)) return ''
    return buildIsolatedHtmlHostDocument(
      htmlCode,
      cssCode,
      {
        fileName: name || 'Document.docx',
        fileType: 'docx',
        title: isVi ? 'Đang mở tài liệu…' : 'Opening document…',
        hint: isVi ? 'Đang tải bố cục…' : 'Loading document layout…',
        appName: 'DOCX',
        accentColor,
      },
      { isCardLayout: true },
    )
  }, [isHtml, htmlCode, cssCode, name, isVi, accentColor])

  // Compute live CSS
  const previewMaterial = useMemo(
    () => ({
      preset,
      themeMode,
      opacity,
      blurPx,
      borderRadiusPx,
      shadowIntensity,
      borderWidthPx,
      accentColor,
    }),
    [
      preset,
      themeMode,
      opacity,
      blurPx,
      borderRadiusPx,
      shadowIntensity,
      borderWidthPx,
      accentColor,
    ],
  )

  const matCss = useMemo(() => buildMaterialCss(previewMaterial), [previewMaterial])

  const handleSave = async () => {
    if (!name.trim()) {
      setErrorMessage(isVi ? 'Tên thẻ không được để trống' : 'Card name cannot be empty')
      return
    }

    setBusy(true)
    setErrorMessage('')

    const updatedCard: OpeningCardDefinition = {
      ...card,
      id: `custom:card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim().slice(0, 60),
      category: 'custom',
      isBuiltIn: false,
      createdAt: Date.now(),
      material: previewMaterial,
      thumbnailColors: [accentColor, '#181b22'],
    }

    const htmlPayload =
      isHtml && (htmlCode || card.htmlAssetId) ? { html: htmlCode, css: cssCode } : undefined

    try {
      await onSave(updatedCard, htmlPayload)
      onClose()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ocs-customizer-dialog-overlay" role="dialog" aria-modal="true">
      <div className="ocs-customizer-dialog">
        <div className="ocs-customizer-header">
          <h3 className="ocs-customizer-title">
            {isVi ? 'Tùy chỉnh thẻ mở tệp' : 'Customize Opening Card'}
          </h3>
          <button
            type="button"
            className="ocs-customizer-close"
            onClick={onClose}
            aria-label={isVi ? 'Đóng' : 'Close'}
          >
            &times;
          </button>
        </div>

        {errorMessage && (
          <div className="ocs-customizer-error" role="alert">
            {errorMessage}
          </div>
        )}

        <div className="ocs-customizer-body">
          {/* Left: Settings controls */}
          <div className="ocs-customizer-controls">
            <div className="ocs-form-group">
              <label className="ocs-form-label" htmlFor="ocs-edit-name">
                {isVi ? 'Tên thẻ:' : 'Card Name:'}
              </label>
              <input
                id="ocs-edit-name"
                type="text"
                className="ocs-form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {isHtml && (
              <div className="ocs-filter-tabs">
                <button
                  type="button"
                  className={`ocs-filter-pill${activeTab === 'material' ? ' active' : ''}`}
                  onClick={() => setActiveTab('material')}
                >
                  {isVi ? 'Chất liệu' : 'Material'}
                </button>
                <button
                  type="button"
                  className={`ocs-filter-pill${activeTab === 'html' ? ' active' : ''}`}
                  onClick={() => setActiveTab('html')}
                >
                  {isVi ? 'Mã HTML & CSS' : 'HTML & CSS'}
                </button>
              </div>
            )}

            {activeTab === 'material' ? (
              <>
                {/* Preset Picker */}
                <div className="ocs-form-group">
                  <label className="ocs-form-label">
                    {isVi ? 'Kiểu hiệu ứng chất liệu:' : 'Material Preset:'}
                  </label>
                  <div className="ocs-preset-selector">
                    {(
                      [
                        { key: 'frosted-glass', en: 'Frosted Glass', vi: 'Kính mờ' },
                        { key: 'liquid-glass', en: 'Liquid Glass', vi: 'Kính lỏng' },
                        { key: 'solid', en: 'Solid', vi: 'Khối đặc' },
                        { key: 'minimal-monochrome', en: 'Minimal', vi: 'Tối giản' },
                      ] as const
                    ).map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={`ocs-preset-btn${preset === p.key ? ' active' : ''}`}
                        onClick={() => setPreset(p.key)}
                      >
                        {isVi ? p.vi : p.en}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Theme Mode */}
                <div className="ocs-form-group">
                  <label className="ocs-form-label">{isVi ? 'Chế độ màu:' : 'Theme Mode:'}</label>
                  <div className="ocs-preset-selector">
                    {(
                      [
                        { key: 'system', en: 'System', vi: 'Theo hệ thống' },
                        { key: 'light', en: 'Light', vi: 'Sáng' },
                        { key: 'dark', en: 'Dark', vi: 'Tối' },
                      ] as const
                    ).map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        className={`ocs-preset-btn${themeMode === t.key ? ' active' : ''}`}
                        onClick={() => setThemeMode(t.key)}
                      >
                        {isVi ? t.vi : t.en}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Sliders */}
                <div className="ocs-form-group">
                  <div className="ocs-slider-header">
                    <label className="ocs-form-label">
                      {isVi ? 'Độ mờ đục (Opacity):' : 'Opacity:'}
                    </label>
                    <span className="ocs-slider-val">{Math.round(opacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={opacity}
                    onChange={(e) => setOpacity(parseFloat(e.target.value))}
                  />
                </div>

                <div className="ocs-form-group">
                  <div className="ocs-slider-header">
                    <label className="ocs-form-label">
                      {isVi ? 'Độ nhòe nền (Blur):' : 'Blur:'}
                    </label>
                    <span className="ocs-slider-val">{blurPx}px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="48"
                    step="2"
                    value={blurPx}
                    onChange={(e) => setBlurPx(parseInt(e.target.value, 10))}
                  />
                </div>

                <div className="ocs-form-group">
                  <div className="ocs-slider-header">
                    <label className="ocs-form-label">
                      {isVi ? 'Bo góc (Border Radius):' : 'Border Radius:'}
                    </label>
                    <span className="ocs-slider-val">{borderRadiusPx}px</span>
                  </div>
                  <input
                    type="range"
                    min="8"
                    max="36"
                    step="1"
                    value={borderRadiusPx}
                    onChange={(e) => setBorderRadiusPx(parseInt(e.target.value, 10))}
                  />
                </div>

                <div className="ocs-form-group">
                  <div className="ocs-slider-header">
                    <label className="ocs-form-label">
                      {isVi ? 'Độ dày viền (Border Width):' : 'Border Width:'}
                    </label>
                    <span className="ocs-slider-val">{borderWidthPx}px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="4"
                    step="1"
                    value={borderWidthPx}
                    onChange={(e) => setBorderWidthPx(parseInt(e.target.value, 10))}
                  />
                </div>

                <div className="ocs-form-group">
                  <div className="ocs-slider-header">
                    <label className="ocs-form-label">
                      {isVi ? 'Độ sâu đổ bóng (Shadow):' : 'Shadow Intensity:'}
                    </label>
                    <span className="ocs-slider-val">{Math.round(shadowIntensity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.0"
                    max="1.0"
                    step="0.05"
                    value={shadowIntensity}
                    onChange={(e) => setShadowIntensity(parseFloat(e.target.value))}
                  />
                </div>

                {/* Accent Color Palette */}
                <div className="ocs-form-group">
                  <label className="ocs-form-label">
                    {isVi ? 'Màu điểm nhấn (Accent):' : 'Accent Color:'}
                  </label>
                  <div className="ocs-color-palette">
                    {COLOR_PRESETS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        className={`ocs-color-circle${accentColor === hex ? ' is-selected' : ''}`}
                        style={{ backgroundColor: hex }}
                        onClick={() => setAccentColor(hex)}
                        aria-label={hex}
                      />
                    ))}
                    <input
                      type="color"
                      className="ocs-color-input-custom"
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      title={isVi ? 'Chọn màu tự do' : 'Pick custom color'}
                    />
                  </div>
                </div>
              </>
            ) : (
              /* HTML & CSS Editors */
              <div className="ocs-html-editors">
                <div className="ocs-form-group">
                  <label className="ocs-form-label">HTML:</label>
                  <textarea
                    rows={6}
                    className="ocs-code-textarea"
                    value={htmlCode}
                    onChange={(e) => setHtmlCode(e.target.value)}
                    placeholder="<div>{{title}}</div>"
                  />
                </div>
                <div className="ocs-form-group">
                  <label className="ocs-form-label">CSS:</label>
                  <textarea
                    rows={6}
                    className="ocs-code-textarea"
                    value={cssCode}
                    onChange={(e) => setCssCode(e.target.value)}
                    placeholder=".my-card { ... }"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Right: Live preview card */}
          <div className="ocs-customizer-preview-col">
            <span className="ocs-preview-label">
              {isVi ? 'Xem trước trực tiếp' : 'Live Preview'}
            </span>
            <div className="ocs-customizer-stage-box">
              {isHtml && activeTab === 'html' && liveHtmlDoc ? (
                <iframe
                  title="Live HTML Card Preview"
                  sandbox="allow-same-origin"
                  srcDoc={liveHtmlDoc}
                  className="ocs-customizer-html-iframe"
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    borderRadius: matCss.borderRadius,
                  }}
                />
              ) : (
                <div
                  className="ocs-customizer-stage-card"
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
                  <div className="ocs-wysiwyg-card-top">
                    <div className="ocs-wysiwyg-app-badge" style={{ backgroundColor: accentColor }}>
                      DOCX
                    </div>
                    <div className="ocs-wysiwyg-doc-info">
                      <span className="ocs-wysiwyg-filename">{name || 'Document.docx'}</span>
                      <span className="ocs-wysiwyg-status">
                        {isVi ? 'Đang mở tài liệu…' : 'Opening document…'}
                      </span>
                    </div>
                    <span className="ocs-wysiwyg-close-indicator" aria-hidden="true">
                      &times;
                    </span>
                  </div>
                  <div className="ocs-wysiwyg-progress-container">
                    <div
                      className="ocs-wysiwyg-progress-bar"
                      style={{ backgroundColor: accentColor }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="ocs-customizer-footer">
          <button type="button" className="set-btn" onClick={onClose} disabled={busy}>
            {isVi ? 'Hủy' : 'Cancel'}
          </button>
          <button
            type="button"
            className="set-btn ocs-btn-primary"
            onClick={handleSave}
            disabled={busy}
          >
            {busy ? (isVi ? 'Đang lưu…' : 'Saving…') : isVi ? 'Lưu thẻ mới' : 'Save as Custom Card'}
          </button>
        </div>
      </div>
    </div>
  )
}
