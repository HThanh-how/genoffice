import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import { buildIsolatedHtmlHostDocument } from '../../../../shared/opening-card-html-sanitizer'
import { buildMaterialCss } from '../../../../shared/opening-card-css'

export type AiCardGenerationMode = 'html' | 'style'

interface AiCardModalProps {
  lang: string
  onSave: (card: OpeningCardDefinition, asset?: { html: string; css: string }) => Promise<void>
  onClose: () => void
}

export function AiCardModal({ lang, onSave, onClose }: AiCardModalProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const [mode, setMode] = useState<AiCardGenerationMode>('html')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [draftCard, setDraftCard] = useState<OpeningCardDefinition | null>(null)
  const [draftHtml, setDraftHtml] = useState('')
  const [draftCss, setDraftCss] = useState('')
  const [activeTab, setActiveTab] = useState<'preview' | 'html' | 'css'>('preview')
  const currentRequestIdRef = useRef<string | null>(null)
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null)

  const onCloseRef = useRef(onClose)
  const mountedRef = useRef(false)
  const savingRef = useRef(false)
  onCloseRef.current = onClose

  const loadingRef = useRef(loading)
  loadingRef.current = loading

  const handleCancelOrClose = () => {
    if (loadingRef.current && currentRequestIdRef.current) {
      window.aiOffice?.cancelAiCardGeneration?.(currentRequestIdRef.current)
      currentRequestIdRef.current = null
    }
    onCloseRef.current()
  }

  // Focus prompt input on mount and handle Escape with capture phase to prevent closing parent SettingsModal
  useEffect(() => {
    mountedRef.current = true
    const previousActive = document.activeElement as HTMLElement | null
    promptInputRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.stopImmediatePropagation()
        e.preventDefault()
        handleCancelOrClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      mountedRef.current = false
      if (currentRequestIdRef.current) {
        window.aiOffice?.cancelAiCardGeneration?.(currentRequestIdRef.current)
        currentRequestIdRef.current = null
      }
      window.removeEventListener('keydown', handleKeyDown, true)
      previousActive?.focus?.()
    }
  }, [])

  const handleGenerate = async () => {
    if (!prompt.trim()) return
    setLoading(true)
    setErrorMessage('')

    const reqId = `aicard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    currentRequestIdRef.current = reqId

    try {
      const res = await window.aiOffice?.generateAiCard?.({
        prompt: prompt.trim(),
        mode,
        requestId: reqId,
      })

      if (!mountedRef.current || currentRequestIdRef.current !== reqId) return

      if (res && res.ok) {
        if (mode === 'html' && res.htmlDraft) {
          const d = res.htmlDraft
          setDraftCard(
            res.card || {
              id: `custom:ai_html_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: d.name || 'AI Generated Scene',
              description: d.description,
              category: 'custom',
              contentKind: 'ai-html',
              isBuiltIn: false,
              createdAt: Date.now(),
              material: {
                preset: 'frosted-glass',
                themeMode: d.themeMode ?? 'system',
                opacity: 0.85,
                blurPx: 22,
                borderRadiusPx: 18,
                shadowIntensity: 0.35,
                accentColor: d.accentColor ?? '#2b7cd3',
              },
              thumbnailColors: [d.accentColor ?? '#2b7cd3', '#181b22'],
              tags: ['ai-html', 'custom'],
            },
          )
          setDraftHtml(d.html)
          setDraftCss(d.css)
        } else if (mode === 'style' && res.card) {
          setDraftCard(res.card)
          setDraftHtml('')
          setDraftCss('')
        } else {
          setErrorMessage(
            res.error ||
              (isVi
                ? 'Không nhận được cấu hình thẻ từ AI. Vui lòng thử lại.'
                : 'No card configuration returned by AI. Please try again.'),
          )
        }
      } else {
        setErrorMessage(
          res?.error ||
            (isVi
              ? 'Không thể sinh thẻ bằng AI. Vui lòng kiểm tra cấu hình mô hình AI trong Cài đặt.'
              : 'Failed to generate card with AI. Please check AI model settings.'),
        )
      }
    } catch (err) {
      if (currentRequestIdRef.current === reqId && mountedRef.current) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (currentRequestIdRef.current === reqId && mountedRef.current) {
        setLoading(false)
      }
    }
  }

  const handleSave = async () => {
    if (!draftCard || savingRef.current) return
    savingRef.current = true
    setLoading(true)
    try {
      if (mode === 'html') {
        await onSave(draftCard, { html: draftHtml, css: draftCss })
      } else {
        await onSave(draftCard)
      }
      if (mountedRef.current) onCloseRef.current()
    } catch (err) {
      if (mountedRef.current) setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      savingRef.current = false
      if (mountedRef.current) setLoading(false)
    }
  }

  const previewDoc = useMemo(() => {
    if (mode !== 'html' || !draftHtml) return ''
    return buildIsolatedHtmlHostDocument(
      draftHtml,
      draftCss,
      {
        fileName: 'Sample_Document.docx',
        fileType: 'docx',
        title: isVi ? 'Đang mở tài liệu…' : 'Opening Document…',
        hint: isVi ? 'Đang tải bố cục…' : 'Loading document layout…',
        appName: 'Word (.docx)',
        accentColor: draftCard?.material.accentColor ?? '#2b7cd3',
      },
      { isCardLayout: true },
    )
  }, [mode, draftHtml, draftCss, isVi, draftCard?.material.accentColor])

  const styleMatCss = useMemo(() => {
    if (mode === 'style' && draftCard?.material) {
      return buildMaterialCss(draftCard.material, { appColor: draftCard.material.accentColor })
    }
    return null
  }, [mode, draftCard?.material])

  return (
    <div className="ocs-customizer-dialog-overlay" role="dialog" aria-modal="true">
      <div className="ocs-customizer-dialog ocs-ai-modal-dialog">
        <div className="ocs-customizer-header">
          <h3 className="ocs-customizer-title">
            {isVi ? '✨ Bộ sinh thẻ bằng AI' : '✨ AI Card Generator'}
          </h3>
          <button
            type="button"
            className="ocs-customizer-close"
            onClick={handleCancelOrClose}
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
          <div className="ocs-customizer-controls">
            {/* Mode Switcher: HTML Scene vs Style Preset vs Image (Disabled) */}
            <div className="ocs-form-group">
              <label className="ocs-form-label">
                {isVi ? 'Chế độ sinh thẻ:' : 'Generation Mode:'}
              </label>
              <div className="ocs-preset-selector">
                <button
                  type="button"
                  className={`ocs-preset-btn${mode === 'html' ? ' active' : ''}`}
                  onClick={() => {
                    setMode('html')
                    setDraftCard(null)
                  }}
                  disabled={loading}
                >
                  {isVi ? 'Mã cảnh HTML' : 'HTML Scene'}
                </button>
                <button
                  type="button"
                  className={`ocs-preset-btn${mode === 'style' ? ' active' : ''}`}
                  onClick={() => {
                    setMode('style')
                    setDraftCard(null)
                  }}
                  disabled={loading}
                >
                  {isVi ? 'Phong cách chất liệu' : 'Style Preset'}
                </button>
                <button
                  type="button"
                  className="ocs-preset-btn"
                  disabled={true}
                  title={
                    isVi
                      ? 'Tạo ảnh AI chưa được hỗ trợ bởi nhà cung cấp hiện tại'
                      : 'AI image generation is not supported by current provider'
                  }
                  style={{ opacity: 0.5, cursor: 'not-allowed' }}
                >
                  {isVi ? 'Ảnh AI (Tắt)' : 'AI Image (Disabled)'}
                </button>
              </div>
            </div>

            <div className="ocs-form-group">
              <label className="ocs-form-label" htmlFor="ocs-ai-prompt">
                {isVi
                  ? 'Mô tả hiệu ứng & phong cách bạn muốn tạo:'
                  : 'Describe the scene and visual style you want:'}
              </label>
              <textarea
                ref={promptInputRef}
                id="ocs-ai-prompt"
                rows={3}
                className="ocs-form-input"
                placeholder={
                  mode === 'html'
                    ? isVi
                      ? 'Ví dụ: Cảnh đêm đầy sao với các đốm sáng lơ lửng, viền phát sáng màu ngọc lam, chuyển động mượt mà…'
                      : 'e.g. Starry night scene with floating glow orbs, cyan luminescence, smooth animation…'
                    : isVi
                      ? 'Ví dụ: Kính mờ siêu mỏng tối giản, màu xanh lá đậm phong cách Bắc Âu, bóng đổ mềm mại…'
                      : 'e.g. Minimalist frosted glass, deep Nordic emerald green accent, soft subtle shadow…'
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={loading}
              />
            </div>

            <button
              type="button"
              className="set-btn ocs-btn-primary"
              disabled={loading || !prompt.trim()}
              onClick={handleGenerate}
            >
              {loading
                ? isVi
                  ? 'Đang sinh thẻ…'
                  : 'Generating…'
                : isVi
                  ? '✨ Bắt đầu sinh thẻ'
                  : '✨ Generate Card'}
            </button>

            {draftCard && (
              <div className="ocs-form-group" style={{ marginTop: '16px' }}>
                <label className="ocs-form-label">{isVi ? 'Tên thẻ:' : 'Card Name:'}</label>
                <input
                  type="text"
                  className="ocs-form-input"
                  value={draftCard.name}
                  onChange={(e) => setDraftCard({ ...draftCard, name: e.target.value })}
                />
              </div>
            )}
          </div>

          <div className="ocs-customizer-preview-col">
            <span className="ocs-preview-label">{isVi ? 'Xem trước' : 'Preview'}</span>
            <div className="ocs-customizer-stage-box" style={{ height: '220px' }}>
              {mode === 'html' && previewDoc ? (
                <div style={{ width: '100%', height: '100%' }}>
                  <div className="ocs-filter-tabs" style={{ marginBottom: '8px' }}>
                    <button
                      type="button"
                      className={`ocs-filter-pill${activeTab === 'preview' ? ' active' : ''}`}
                      onClick={() => setActiveTab('preview')}
                    >
                      {isVi ? 'Xem thử' : 'Preview'}
                    </button>
                    <button
                      type="button"
                      className={`ocs-filter-pill${activeTab === 'html' ? ' active' : ''}`}
                      onClick={() => setActiveTab('html')}
                    >
                      HTML
                    </button>
                    <button
                      type="button"
                      className={`ocs-filter-pill${activeTab === 'css' ? ' active' : ''}`}
                      onClick={() => setActiveTab('css')}
                    >
                      CSS
                    </button>
                  </div>

                  {activeTab === 'preview' ? (
                    <iframe
                      sandbox="allow-same-origin"
                      srcDoc={previewDoc}
                      className="ocs-iframe-preview"
                      title="AI Card Preview"
                      style={{
                        width: '100%',
                        height: '160px',
                        border: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : activeTab === 'html' ? (
                    <textarea
                      rows={6}
                      className="ocs-code-textarea"
                      value={draftHtml}
                      onChange={(e) => setDraftHtml(e.target.value)}
                    />
                  ) : (
                    <textarea
                      rows={6}
                      className="ocs-code-textarea"
                      value={draftCss}
                      onChange={(e) => setDraftCss(e.target.value)}
                    />
                  )}
                </div>
              ) : mode === 'style' && styleMatCss ? (
                <div
                  className="ocs-customizer-stage-card"
                  style={{
                    background: styleMatCss.background,
                    backdropFilter: styleMatCss.backdropFilter,
                    WebkitBackdropFilter: styleMatCss.backdropFilter,
                    border: styleMatCss.border,
                    borderRadius: styleMatCss.borderRadius,
                    boxShadow: styleMatCss.boxShadow,
                    color: styleMatCss.color,
                    width: '85%',
                    margin: 'auto',
                  }}
                >
                  <div className="ocs-wysiwyg-card-top">
                    <div
                      className="ocs-wysiwyg-app-badge"
                      style={{ backgroundColor: styleMatCss.accentColor }}
                    >
                      DOCX
                    </div>
                    <div className="ocs-wysiwyg-doc-info">
                      <span className="ocs-wysiwyg-filename">Document.docx</span>
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
                      style={{ backgroundColor: styleMatCss.accentColor }}
                    />
                  </div>
                </div>
              ) : (
                <div className="ocs-preview-empty">
                  <span>
                    {isVi
                      ? 'Nhập mô tả và bấm "Bắt đầu sinh thẻ" để tạo'
                      : 'Enter a prompt and click "Generate Card"'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="ocs-customizer-footer">
          <button type="button" className="set-btn" onClick={handleCancelOrClose}>
            {isVi ? 'Hủy' : 'Cancel'}
          </button>
          {draftCard && (
            <button
              type="button"
              className="set-btn ocs-btn-primary"
              onClick={handleSave}
              disabled={loading}
            >
              {isVi ? 'Lưu thẻ vào thư viện' : 'Save to Library'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
