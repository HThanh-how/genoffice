import type { Lang } from '@genoffice/i18n'
import { issueWords, type en } from '../indexing-activity-i18n'
import { fill, type ActivityCopy } from '../indexing-activity-copy'
import type { EtaEstimate, IndexView } from '../indexing-activity-model'

export type Words = typeof en
export type ActionResult = { ok: boolean; error?: string }

export function formatCount(value: number, lang: Lang): string {
  try {
    return new Intl.NumberFormat(lang).format(value)
  } catch {
    return String(value)
  }
}

export function etaText(eta: EtaEstimate, copy: ActivityCopy): string {
  if (eta.unit === 'seconds') return copy.etaSoon
  return fill(eta.unit === 'minutes' ? copy.etaMinutes : copy.etaHours, { n: eta.value })
}

export function headline(view: IndexView, words: Words, copy: ActivityCopy): string {
  switch (view.kind) {
    case 'scanning':
      return words.scanning
    case 'indexing':
      return words.indexing
    case 'downloading':
      return words.downloading
    case 'model-error':
      return copy.modelTitle
    case 'paused':
      return words.paused
    case 'stopped':
      return words.stopped
    default:
      return words.done
  }
}

/** One plain sentence under the headline: the numbers that matter in this state. */
export function detail(view: IndexView, lang: Lang, copy: ActivityCopy): string {
  const n = (value: number) => formatCount(value, lang)
  switch (view.kind) {
    case 'scanning':
      return fill(copy.foundSoFar, { n: n(view.found) })
    case 'indexing':
    case 'downloading':
      return fill(copy.progressFiles, { done: n(view.finished), total: n(view.total) })
    case 'paused':
      return copy.pausedBody
    case 'done':
      return fill(copy.doneBody, { n: n(view.ready) })
    case 'model-error':
      return copy.modelBody
    default:
      return ''
  }
}

export function issueWordsFor(lang: Lang) {
  return issueWords[lang] ?? issueWords.en
}
