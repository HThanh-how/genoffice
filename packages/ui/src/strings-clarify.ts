import { createI18n, type Params, type Lang } from '@genoffice/i18n'
import ar from './i18n/clarify/ar'
import cs from './i18n/clarify/cs'
import de from './i18n/clarify/de'
import en from './i18n/clarify/en'
import es from './i18n/clarify/es'
import fr from './i18n/clarify/fr'
import he from './i18n/clarify/he'
import hi from './i18n/clarify/hi'
import id from './i18n/clarify/id'
import it from './i18n/clarify/it'
import ja from './i18n/clarify/ja'
import ko from './i18n/clarify/ko'
import ms from './i18n/clarify/ms'
import nl from './i18n/clarify/nl'
import pl from './i18n/clarify/pl'
import pt from './i18n/clarify/pt'
import ru from './i18n/clarify/ru'
import th from './i18n/clarify/th'
import vi from './i18n/clarify/vi'
import zhTW from './i18n/clarify/zh-TW'
import zh from './i18n/clarify/zh'

export type ClarifyKey = keyof typeof zh
const strings = {
  ar: ar,
  cs: cs,
  de: de,
  en: en,
  es: es,
  fr: fr,
  he: he,
  hi: hi,
  id: id,
  it: it,
  ja: ja,
  ko: ko,
  ms: ms,
  nl: nl,
  pl: pl,
  pt: pt,
  ru: ru,
  th: th,
  vi: vi,
  'zh-TW': zhTW,
  zh: zh,
}
const translate = createI18n(strings)
export const clarifyText = (lang: Lang, key: ClarifyKey, params?: Params): string =>
  translate(lang, key, params)
