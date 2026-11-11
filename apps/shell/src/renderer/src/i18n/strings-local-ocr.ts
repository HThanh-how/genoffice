import { copy as l0 } from './local-ocr/zh'
import { copy as l1 } from './local-ocr/zh-TW'
import { copy as l2 } from './local-ocr/en'
import { copy as l3 } from './local-ocr/vi'
import { copy as l4 } from './local-ocr/ar'
import { copy as l5 } from './local-ocr/cs'
import { copy as l6 } from './local-ocr/de'
import { copy as l7 } from './local-ocr/es'
import { copy as l8 } from './local-ocr/fr'
import { copy as l9 } from './local-ocr/he'
import { copy as l10 } from './local-ocr/hi'
import { copy as l11 } from './local-ocr/id'
import { copy as l12 } from './local-ocr/it'
import { copy as l13 } from './local-ocr/ja'
import { copy as l14 } from './local-ocr/ko'
import { copy as l15 } from './local-ocr/ms'
import { copy as l16 } from './local-ocr/nl'
import { copy as l17 } from './local-ocr/pl'
import { copy as l18 } from './local-ocr/pt'
import { copy as l19 } from './local-ocr/ru'
import { copy as l20 } from './local-ocr/th'

const copies: Record<string, typeof l2> = {
  zh: l0,
  'zh-TW': l1,
  en: l2,
  vi: l3,
  ar: l4,
  cs: l5,
  de: l6,
  es: l7,
  fr: l8,
  he: l9,
  hi: l10,
  id: l11,
  it: l12,
  ja: l13,
  ko: l14,
  ms: l15,
  nl: l16,
  pl: l17,
  pt: l18,
  ru: l19,
  th: l20,
}
export const localOcrCopy = (lang: string): typeof l2 => copies[lang] ?? l2
