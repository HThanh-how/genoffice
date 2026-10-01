import type { Words } from './format'

export function PanelHeader({
  words,
  root,
  folderName,
  onClose,
}: {
  words: Words
  root: string
  folderName: string
  onClose: () => void
}) {
  return (
    <header>
      <div className="indexing-activity-title">
        <strong>{words.title}</strong>
        <span title={root}>{folderName}</span>
      </div>
      <button
        type="button"
        className="indexing-activity-close"
        aria-label={words.close}
        onClick={onClose}
      >
        ×
      </button>
    </header>
  )
}
