import { ClarifyCard as SharedClarifyCard } from '@genoffice/ui'
import { useI18n } from '../i18n/locale'
import type { ClarifyQuestion } from '../ai/tools'

/** The shared questionnaire keeps HTML and Home on the same interaction flow. */
export function ClarifyCard(props: {
  questions: ClarifyQuestion[]
  onSubmit: (answers: string, qa: Array<{ q: string; a: string }>) => void
  onSkip: () => void
}) {
  const { t } = useI18n()
  return <SharedClarifyCard {...props} t={t} />
}
