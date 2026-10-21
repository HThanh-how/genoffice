import type { EtaEstimate } from '../indexing-activity-model'
import type { IndexSummary } from './index-summary'

/**
 * The one sentence at the top of the index overview. It answers a single question: is search ready,
 * and if not, why and for how long. Pure, so the wording rules can be tested without a screen.
 */
export type IndexStatusKind = 'working' | 'paused' | 'attention' | 'ready'

/** Why the work is on hold; 'saver' is the resource-saver mode of the search model. */
export type PauseWhy =
  | 'user'
  | 'battery'
  | 'low-battery'
  | 'battery-saver'
  | 'locked'
  | 'low-memory'
  | 'thermal'
  | 'suspended'
  | 'saver'

export interface IndexStatus {
  kind: IndexStatusKind
  why?: PauseWhy
  percent: number | null
  waiting: number
  ready: number
  eta: EtaEstimate | null
}

export interface IndexStatusInput {
  summary: IndexSummary
  /** indexing is switched off by the person */
  switchedOff: boolean
  /** the indexing policy is holding the work back */
  held: boolean
  pauseReason?: string
  /** the search model is blocked to save resources */
  modelBlocked: boolean
  /** a file is being read right now (even when the queue count says 0) */
  reading: boolean
  ready: number
  eta: EtaEstimate | null
}

const KNOWN_WHY = new Set<string>([
  'user',
  'battery',
  'low-battery',
  'battery-saver',
  'locked',
  'low-memory',
  'thermal',
  'suspended',
])

export function deriveIndexStatus(input: IndexStatusInput): IndexStatus {
  const { summary } = input
  const base = {
    percent: summary.percent,
    waiting: summary.waiting,
    ready: input.ready,
    eta: input.eta,
  }
  if (input.switchedOff) return { kind: 'paused', why: 'user', ...base, eta: null }
  if (input.held || input.modelBlocked) {
    const why: PauseWhy =
      input.pauseReason && KNOWN_WHY.has(input.pauseReason)
        ? (input.pauseReason as PauseWhy)
        : input.modelBlocked
          ? 'saver'
          : 'user'
    return { kind: 'paused', why, ...base, eta: null }
  }
  if (summary.active || input.reading) return { kind: 'working', ...base }
  if (summary.problems > 0) return { kind: 'attention', ...base, eta: null }
  return { kind: 'ready', ...base, eta: null }
}

/** Copy the sentence needs; it comes from the dashboard dictionary. */
export interface StatusCopy {
  working: string
  left: string
  paused: string
  ready: string
  why: Record<PauseWhy, string>
  resumeWhen: Record<PauseWhy, string>
}

export interface EtaCopy {
  etaSoon: string
  etaMinutes: string
  etaHours: string
}

function fillIn(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? String(values[key]) : m,
  )
}

export function etaText(eta: EtaEstimate, copy: EtaCopy, num: (n: number) => string): string {
  if (eta.unit === 'seconds') return copy.etaSoon
  return fillIn(eta.unit === 'minutes' ? copy.etaMinutes : copy.etaHours, { n: num(eta.value) })
}

/** "Getting ready · 77% · About 12 min left", "Paused: battery is low. Continues when plugged in." */
export function statusSentence(
  status: IndexStatus,
  copy: StatusCopy,
  eta: EtaCopy,
  num: (n: number) => string,
): string {
  switch (status.kind) {
    case 'working': {
      const parts = [copy.working]
      if (status.percent !== null) parts.push(`${status.percent}%`)
      if (status.eta) parts.push(etaText(status.eta, eta, num))
      else if (status.waiting > 0) parts.push(fillIn(copy.left, { n: num(status.waiting) }))
      return parts.join(' · ')
    }
    case 'paused': {
      const why = status.why ?? 'user'
      return fillIn(copy.paused, { why: copy.why[why], when: copy.resumeWhen[why] })
    }
    default:
      return fillIn(copy.ready, { n: num(status.ready) })
  }
}
