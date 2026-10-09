/**
 * Reasoning effort per kind of work, for `agy --effort`. Pure and browser-safe.
 *
 * Retrieval-style jobs (web search, OCR, classification) gain nothing from long reasoning, so they
 * ask for low effort; chat keeps medium. Two guards keep this from ever surprising the user:
 *  - a model id that already carries its effort (`gemini-3.8-flash-high`, `gpt-oss-120b-medium`)
 *    is the user's explicit choice: `--effort` would swap it for another variant, so it is not sent;
 *  - the flag is only sent when the installed agy lists it in `--help` (see agy-capabilities.ts).
 */

export type AgyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AgyTask = 'chat' | 'search' | 'ocr' | 'classify' | 'media' | 'image'

export const AGY_EFFORTS: readonly AgyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Defaults per task; deliberately the same as what a chat turn gets when the work is unknown. */
export const AGY_TASK_EFFORT: Readonly<Record<AgyTask, AgyEffort>> = {
  chat: 'medium',
  search: 'low',
  ocr: 'low',
  classify: 'low',
  media: 'medium',
  image: 'medium',
}

export function isAgyEffort(value: unknown): value is AgyEffort {
  return typeof value === 'string' && (AGY_EFFORTS as readonly string[]).includes(value)
}

/** `gemini-3.8-flash-low`, `gpt-oss-120b-medium`: the effort is part of the model id. */
const BAKED_EFFORT = /-(?:low|medium|high|xhigh|max)$/i

export function agyModelHasBakedEffort(model: string): boolean {
  return BAKED_EFFORT.test(model.trim())
}

export interface ResolveEffortInput {
  task?: AgyTask | undefined
  /** an explicit request for this one run; anything that is not a known level is ignored */
  effort?: AgyEffort | undefined
  model: string
  /** value of GENOFFICE_AGY_EFFORT: `off` disables the flag, a level forces it */
  env?: string | undefined
}

/**
 * The level to pass, or undefined for "do not pass `--effort`". Nothing is passed when no task or
 * level was named, so callers that have not opted in keep the exact old command line.
 */
export function resolveAgyEffort(input: ResolveEffortInput): AgyEffort | undefined {
  const override = input.env?.trim().toLowerCase()
  if (override === 'off' || override === '0' || override === 'false') return undefined
  if (agyModelHasBakedEffort(input.model)) return undefined
  if (isAgyEffort(override)) return override
  if (isAgyEffort(input.effort)) return input.effort
  return input.task ? AGY_TASK_EFFORT[input.task] : undefined
}

/** Whether `agy --help` output documents the given flag (a whole-word match on the flag name). */
export function helpMentionsFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?![A-Za-z0-9-])`, 'm').test(help)
}
