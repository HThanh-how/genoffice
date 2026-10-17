import React, { useEffect, useRef, useState } from 'react'

interface MediaImportModalProps {
  lang: string
  onImport: (file: File) => Promise<void>
  onClose: () => void
}

export function MediaImportModal({
  lang,
  onImport,
  onClose,
}: MediaImportModalProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [dragOver, setDragOver] = useState(false)

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

  const processFile = async (file: File) => {
    if (!file) return
    setBusy(true)
    setErrorMessage('')

    const MAX_BYTES = 10 * 1024 * 1024 // 10 MB backend cap
    if (file.size > MAX_BYTES) {
      setErrorMessage(
        isVi ? 'Tệp vượt quá giới hạn 10MB cho phép.' : 'File exceeds the 10MB maximum size limit.',
      )
      setBusy(false)
      return
    }

    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (!validTypes.includes(file.type)) {
      setErrorMessage(
        isVi
          ? 'Định dạng tệp không được hỗ trợ. Vui lòng chọn ảnh PNG, JPEG, WEBP hoặc GIF.'
          : 'Unsupported file format. Please select a PNG, JPEG, WEBP, or GIF image.',
      )
      setBusy(false)
      return
    }

    try {
      await onImport(file)
      onClose()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      void processFile(e.dataTransfer.files[0])
    }
  }

  return (
    <div className="ocs-customizer-dialog-overlay" role="dialog" aria-modal="true">
      <div className="ocs-customizer-dialog ocs-media-modal-dialog">
        <div className="ocs-customizer-header">
          <h3 className="ocs-customizer-title">
            {isVi ? '🖼️ Nhập hình ảnh / Media riêng' : '🖼️ Import Personal Media'}
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
          <div
            className={`ocs-dropzone${dragOver ? ' is-drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  void processFile(e.target.files[0])
                }
              }}
            />
            <div className="ocs-dropzone-icon">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p className="ocs-dropzone-title">
              {isVi
                ? 'Kéo thả tệp ảnh vào đây, hoặc nhấn để duyệt'
                : 'Drag & drop image file here, or click to browse'}
            </p>
            <p className="ocs-dropzone-desc">
              {isVi
                ? 'Hỗ trợ PNG, JPEG, WEBP, GIF (tối đa 10MB)'
                : 'Supports PNG, JPEG, WEBP, GIF (up to 10MB)'}
            </p>
          </div>
        </div>

        <div className="ocs-customizer-footer">
          <button type="button" className="set-btn" onClick={onClose} disabled={busy}>
            {isVi ? 'Hủy' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
