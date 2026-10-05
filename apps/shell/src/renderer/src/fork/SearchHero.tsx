import { useEffect, useRef } from 'react'
import { useI18n } from '../locale'

export interface SearchHeroProps {
  value: string
  onChange: (value: string) => void
  onClear: () => void
  placeholder?: string
  autoFocus?: boolean
}

export function SearchHero({
  value,
  onChange,
  onClear,
  placeholder,
  autoFocus = true,
}: SearchHeroProps) {
  const { lang } = useI18n()
  const isVi = lang === 'vi'
  const inputRef = useRef<HTMLInputElement>(null)

  const defaultPlaceholder = isVi
    ? 'Tìm kiếm tên tệp và nội dung...'
    : 'Search file names and contents...'

  const clearLabel = isVi ? 'Xoá tìm kiếm' : 'Clear search'

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus()
    }
  }, [autoFocus])

  return (
    <div className="idx-search-hero">
      <div className="idx-search-hero-box">
        <svg
          className="idx-search-hero-icon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>

        <input
          ref={inputRef}
          type="search"
          className="idx-search-hero-input"
          value={value}
          placeholder={placeholder || defaultPlaceholder}
          aria-label={placeholder || defaultPlaceholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.stopPropagation()
              onClear()
            }
          }}
        />

        {value.length > 0 && (
          <button
            type="button"
            className="idx-search-hero-clear"
            onClick={onClear}
            aria-label={clearLabel}
            title={clearLabel}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
              <path
                d="M3 3l8 8M11 3L3 11"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
