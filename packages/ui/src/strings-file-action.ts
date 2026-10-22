import type { Lang } from '@genoffice/i18n'
import { zh as zh } from './i18n/file-action/zh'
import { strings as en } from './i18n/file-action/en'
import { strings as vi } from './i18n/file-action/vi'
import { strings as zh_TW } from './i18n/file-action/zh-TW'
import { strings as ja } from './i18n/file-action/ja'
import { strings as ko } from './i18n/file-action/ko'
import { strings as fr } from './i18n/file-action/fr'
import { strings as de } from './i18n/file-action/de'
import { strings as es } from './i18n/file-action/es'
import { strings as th } from './i18n/file-action/th'
import { strings as id } from './i18n/file-action/id'
import { strings as ru } from './i18n/file-action/ru'
import { strings as ar } from './i18n/file-action/ar'
import { strings as pt } from './i18n/file-action/pt'
import { strings as it } from './i18n/file-action/it'
import { strings as pl } from './i18n/file-action/pl'
import { strings as cs } from './i18n/file-action/cs'
import { strings as nl } from './i18n/file-action/nl'
import { strings as ms } from './i18n/file-action/ms'
import { strings as he } from './i18n/file-action/he'
import { strings as hi } from './i18n/file-action/hi'

export const FILE_ACTION_LABELS = {
  zh: zh,
  en: en,
  vi: vi,
  'zh-TW': zh_TW,
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
} satisfies Record<Lang, Record<keyof typeof zh, string>>
