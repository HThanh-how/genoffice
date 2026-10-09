import { useI18n } from '../locale'
import { en, strings } from '../indexing-activity-i18n'

/**
 * "N released": documents whose vectors were released to save space. They are not pending work; they stay
 * searchable by name/text and reload when opened. Renders nothing for 0.
 */
export function ReleasedChip({ count }: { count: number | undefined }) {
  const { lang, dateLocale } = useI18n()
  if (!count || count <= 0) return null
  const words = strings[lang] ?? en
  return (
    <span className="idx-released-chip" title={words.releasedHint}>
      <strong>{count.toLocaleString(dateLocale)}</strong> {words.released.toLowerCase()}
    </span>
  )
}
