import type { Lang } from '@genoffice/i18n'
import type { AgyOcrStatus } from '../../../shared/fork/agy-ocr'
import { useAgyOcrStatus } from './AgyOcrSettings'
import { popupLine } from './agy-ocr-strings'

const POLL_MS = 4000

interface NoteApi {
  getAgyOcrStatus?: () => Promise<AgyOcrStatus | null>
}

/**
 * One quiet line in the Document index popup while the scanned-PDF reader is on:
 * "Reading scanned PDFs: 7/10 pages today · 1,426 files waiting". Renders nothing otherwise.
 */
export function AgyOcrNote({ api, lang }: { api: NoteApi; lang: Lang }) {
  const [status] = useAgyOcrStatus(api, POLL_MS)
  const line = status?.settings.enabled ? popupLine(lang, status) : null
  if (!line) return null
  return (
    <p className="indexing-activity-ocr" aria-live="polite">
      {line}
    </p>
  )
}
