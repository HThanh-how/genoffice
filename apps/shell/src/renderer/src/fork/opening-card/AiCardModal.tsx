import React, { useEffect, useRef, useState } from 'react'
import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import { buildIsolatedHtmlHostDocument } from '../../../../shared/opening-card-html-sanitizer'

interface AiCardModalProps {
  lang: string
  onSave: (card: OpeningCardDefinition, asset: { html: string; css: string }) => Promise<void>
  onClose: () => void
}

export function AiCardModal({ lang, onSave, onClose }: AiCardModalProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [draftCard, setDraftCard] = useState<OpeningCardDefinition | null>(null)
  const [draftHtml, setDraftHtml] = useState('')
  const [draftCss, setDraftCss] = useState('')
  const [activeTab, setActiveTab] = useState<'preview' | 'html' | 'css'>('preview')
  const currentRequestIdRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (currentRequestIdRef.current) {
        window.aiOffice?.cancelAiCardGeneration?.(currentRequestIdRef.current)
      }
    }
  }, [])

  const handleCancelOrClose = () => {
    if (loading && currentRequestIdRef.current) {
      window.aiOffice?.cancelAiCardGeneration?.(currentRequestIdRef.current)
      currentRequestIdRef.current = null
    }
    onClose()
  }

  const handleGenerate = async () => {
    if (!prompt.trim()) return
    setLoading(true)
    setErrorMessage('')

    const reqId = `aicard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    currentRequestIdRef.current = reqId

    try {
      const res = await window.aiOffice?.generateAiCard?.({
        prompt: prompt.trim(),
        mode: 'html',
        requestId: reqId,
      })

      if (res && res.ok && res.htmlDraft) {
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
      } else {
        setErrorMessage(
          res?.error ||
            (isVi
              ? 'Không thể sinh thẻ bằng AI. Vui lòng kiểm tra cấu hình mô hình AI trong Cài đặt.'
              : 'Failed to generate card with AI. Please check AI model settings.'),
        )
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!draftCard) return
    setLoading(true)
    try {
      await onSave(draftCard, { html: draftHtml, css: draftCss })
      onClose()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const previewDoc = draftHtml
    ? buildIsolatedHtmlHostDocument(
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
    : ''

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
            <div className="ocs-form-group">
              <label className="ocs-form-label" htmlFor="ocs-ai-prompt">
                {isVi
                  ? 'Mô tả hiệu ứng & phong cách bạn muốn tạo:'
                  : 'Describe the scene and visual style you want:'}
              </label>
              <textarea
                id="ocs-ai-prompt"
                rows={3}
                className="ocs-form-input"
                placeholder={
                  isVi
                    ? 'Ví dụ: Kính mờ với viền phát sáng màu xanh lam ngọc, hiệu ứng chuyển động sóng biển êm dịu…'
                    : 'e.g. Floating frosted glass with cyan glowing borders and gentle wave animation…'
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
              {previewDoc ? (
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
                      sandbox=""
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
