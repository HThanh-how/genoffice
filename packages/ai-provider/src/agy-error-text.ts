import { zh } from './i18n/agy-errors/zh'
import { en } from './i18n/agy-errors/en'
import { ja } from './i18n/agy-errors/ja'
import { ko } from './i18n/agy-errors/ko'
import { fr } from './i18n/agy-errors/fr'
import { de } from './i18n/agy-errors/de'
import { es } from './i18n/agy-errors/es'
import { th } from './i18n/agy-errors/th'
import { id } from './i18n/agy-errors/id'
import { ru } from './i18n/agy-errors/ru'
import { ar } from './i18n/agy-errors/ar'
import { pt } from './i18n/agy-errors/pt'
import { it } from './i18n/agy-errors/it'
import { pl } from './i18n/agy-errors/pl'
import { cs } from './i18n/agy-errors/cs'
import { nl } from './i18n/agy-errors/nl'
import { ms } from './i18n/agy-errors/ms'
import { he } from './i18n/agy-errors/he'
import { hi } from './i18n/agy-errors/hi'
import { zhTW } from './i18n/agy-errors/zh-TW'
import { vi } from './i18n/agy-errors/vi'

/**
 * Localized messages for typed Antigravity failures. Browser-safe (no Node imports): the editors'
 * IPC transports call it with the UI language to turn an error code into text. Thin aggregator
 * over `i18n/agy-errors/<lang>.ts`; `zh` defines the key set and each shard must match it.
 */

/** The UI languages (same set as `Lang` in @genoffice/i18n, which a test keeps in step). */
export type AgyErrorLang =
  | 'zh'
  | 'en'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'th'
  | 'id'
  | 'ru'
  | 'ar'
  | 'pt'
  | 'it'
  | 'pl'
  | 'cs'
  | 'nl'
  | 'ms'
  | 'he'
  | 'hi'
  | 'zh-TW'
  | 'vi'

type Dict = Record<keyof typeof zh, string>

const DICTS: Record<AgyErrorLang, Dict> = {
  zh: zh,
  en: en,
  ja: ja,
  ko: ko,
  fr: fr,
  de: de,
  es: es,
  th: th,
  id: id,
  ru: ru,
  ar: ar,
  pt: pt,
  it: it,
  pl: pl,
  cs: cs,
  nl: nl,
  ms: ms,
  he: he,
  hi: hi,
  'zh-TW': zhTW,
  vi: vi,
}

export type AgyErrorTextCode = 'quota' | 'auth'

function dictFor(lang: string): Dict {
  return (DICTS as Record<string, Dict>)[lang] ?? DICTS.en
}

/** "3:30 PM" today, "Oct 10, 3:30 PM" otherwise, in the UI language and the computer's time zone. */
export function formatAgyResetTime(
  resetAt: number,
  lang: string,
  now: number = Date.now(),
): string {
  const date = new Date(resetAt)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  try {
    return new Intl.DateTimeFormat(lang, options).format(date)
  } catch {
    return new Intl.DateTimeFormat('en', options).format(date)
  }
}

/**
 * The user-facing text of an Antigravity quota / sign-in failure in `lang` (any string; unknown
 * languages fall back to English). `resetAt` (epoch ms) adds the reset time to the quota message.
 */
export function agyErrorText(
  lang: string,
  code: AgyErrorTextCode,
  options: { resetAt?: number | undefined; now?: number | undefined } = {},
): string {
  const dict = dictFor(lang)
  if (code === 'auth') return dict.agyErrAuth
  if (options.resetAt === undefined) return dict.agyErrQuota
  return dict.agyErrQuotaAt.replace(
    '{time}',
    formatAgyResetTime(options.resetAt, lang, options.now),
  )
}
