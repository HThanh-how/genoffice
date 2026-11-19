import type { Lang } from '@genoffice/i18n'
import { copy as l0 } from './i18n/local-chat/en'
import { copy as l1 } from './i18n/local-chat/vi'
import { copy as l2 } from './i18n/local-chat/zh'
import { copy as l3 } from './i18n/local-chat/zh-TW'
import { copy as l4 } from './i18n/local-chat/hu'
import { copy as l5 } from './i18n/local-chat/de'
import { copy as l6 } from './i18n/local-chat/fr'
import { copy as l7 } from './i18n/local-chat/es'
import { copy as l8 } from './i18n/local-chat/it'
import { copy as l9 } from './i18n/local-chat/pt'
import { copy as l10 } from './i18n/local-chat/nl'
import { copy as l11 } from './i18n/local-chat/pl'
import { copy as l12 } from './i18n/local-chat/cs'
import { copy as l13 } from './i18n/local-chat/ru'
import { copy as l14 } from './i18n/local-chat/tr'
import { copy as l15 } from './i18n/local-chat/ja'
import { copy as l16 } from './i18n/local-chat/ko'
import { copy as l17 } from './i18n/local-chat/id'
import { copy as l18 } from './i18n/local-chat/ms'
import { copy as l19 } from './i18n/local-chat/th'
import { copy as l20 } from './i18n/local-chat/ar'
import { copy as l21 } from './i18n/local-chat/he'
import { copy as l22 } from './i18n/local-chat/hi'
const copies = {
  en: l0,
  vi: l1,
  zh: l2,
  'zh-TW': l3,
  hu: l4,
  de: l5,
  fr: l6,
  es: l7,
  it: l8,
  pt: l9,
  nl: l10,
  pl: l11,
  cs: l12,
  ru: l13,
  tr: l14,
  ja: l15,
  ko: l16,
  id: l17,
  ms: l18,
  th: l19,
  ar: l20,
  he: l21,
  hi: l22,
} satisfies Record<Lang, Record<keyof typeof l0, string>>
export const localChatCopy = (lang: Lang): Record<keyof typeof l0, string> => copies[lang]

let language: () => Lang = () => 'en'
export function setLocalChatLanguage(get: () => Lang): void {
  language = get
}
export function localChatText() {
  return localChatCopy(language())
}
