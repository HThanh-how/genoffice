import { copy as en } from './settings-card/en'
import { copy as vi } from './settings-card/vi'
import { copy as zh } from './settings-card/zh'
import { copy as zhTW } from './settings-card/zh-TW'
import { copy as ar } from './settings-card/ar'
import { copy as cs } from './settings-card/cs'
import { copy as de } from './settings-card/de'
import { copy as es } from './settings-card/es'
import { copy as fr } from './settings-card/fr'
import { copy as he } from './settings-card/he'
import { copy as hi } from './settings-card/hi'
import { copy as id } from './settings-card/id'
import { copy as it } from './settings-card/it'
import { copy as ja } from './settings-card/ja'
import { copy as ko } from './settings-card/ko'
import { copy as ms } from './settings-card/ms'
import { copy as nl } from './settings-card/nl'
import { copy as pl } from './settings-card/pl'
import { copy as pt } from './settings-card/pt'
import { copy as ru } from './settings-card/ru'
import { copy as th } from './settings-card/th'

const copies: Record<string, typeof en> = {
  en,
  vi,
  zh,
  'zh-TW': zhTW,
  ar,
  cs,
  de,
  es,
  fr,
  he,
  hi,
  id,
  it,
  ja,
  ko,
  ms,
  nl,
  pl,
  pt,
  ru,
  th,
}
export const settingsCardCopy = (lang: string): typeof en => copies[lang] ?? en
export const groupText = (lang: string, key: keyof typeof en): string => settingsCardCopy(lang)[key]
export const groupHint = (lang: string, key: 'appearance' | 'ai' | 'files' | 'privacy'): string =>
  settingsCardCopy(lang)[`${key}Hint`]
