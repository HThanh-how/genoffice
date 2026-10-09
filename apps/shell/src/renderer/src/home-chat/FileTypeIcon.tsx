import type { CSSProperties } from 'react'
import { extensionOf, fileTypeTokens, type FileKind } from '../file-icons'

/** Inner mark of each family on the shared page outline: the shape says the type, not the colour alone. */
const MARKS: Record<FileKind, React.JSX.Element> = {
  pdf: <path d="M6.5 13.5c2-1 3.5-3.5 3.5-6 0 2 1.5 4.5 4 5.5-2.5-.2-5 .2-7.5.5Z" />,
  sheet: <path d="M6 8h8M6 11h8M6 14h8M9.5 6v9M13 6v9" strokeWidth="1.1" fill="none" />,
  doc: <path d="M6.5 8h7M6.5 10.8h7M6.5 13.6h4.5" strokeWidth="1.3" fill="none" />,
  slides: <path d="M6 7.5h8v5.5H6zM10 13v2M8 15.2h4" strokeWidth="1.2" fill="none" />,
  image: <path d="m6 14 2.6-3 2 2 1.4-1.6L14.5 14zM8 8.3h.01" strokeWidth="1.3" fill="none" />,
  video: <path d="m8.5 8 4.5 2.5L8.5 13z" />,
  audio: (
    <path
      d="M8 13V8.2l5-1V12M8 13a1.2 1.2 0 1 1-1.2-1.2M13 12a1.2 1.2 0 1 1-1.2-1.2"
      strokeWidth="1.2"
      fill="none"
    />
  ),
  text: (
    <path
      d="M6.5 8h7M6.5 10.5h7M6.5 13h5"
      strokeWidth="1.1"
      fill="none"
      strokeDasharray="1.6 1.2"
    />
  ),
  archive: (
    <path d="M10 5.5v9M8.7 7h2.6M8.7 9h2.6M8.7 11h2.6M8.7 13h2.6" strokeWidth="1.1" fill="none" />
  ),
  other: (
    <path
      d="M7.2 9a2.8 2.8 0 1 1 3.6 2.7c-.5.2-.8.6-.8 1.1M10 15.2h.01"
      strokeWidth="1.3"
      fill="none"
    />
  ),
}

/**
 * The type tile of a file: a tinted square with the family's mark, coloured by the `--file-*`
 * tokens (light and dark). The extension is also the accessible type name, so colour is never
 * the only signal.
 */
export function FileTypeIcon({ name, size = 22 }: { name: string; size?: number }) {
  const { kind, fg, soft } = fileTypeTokens(name)
  const ext = extensionOf(name)
  const style = {
    '--ft': `var(${fg})`,
    '--ft-soft': `var(${soft})`,
    width: size,
    height: size,
  } as CSSProperties
  return (
    <span className="hc-ft" data-kind={kind} data-ext={ext} style={style} aria-hidden="true">
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 2.8h6.4L15 6.4v10.8H5z M11.2 2.8v3.8H15" strokeWidth="1.3" />
        <g fill="currentColor" stroke="currentColor">
          {MARKS[kind]}
        </g>
      </svg>
    </span>
  )
}
