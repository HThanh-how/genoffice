import { en } from './index-v2/en'
import { vi } from './index-v2/vi'
import { zh } from './index-v2/zh'
import { zhTW } from './index-v2/zh-TW'
export const indexV2Copy: Record<string, Record<keyof typeof zh, string>> = {
  en,
  vi,
  zh,
  'zh-TW': zhTW,
}
export const indexV2Words = (lang: string) => indexV2Copy[lang] ?? en
