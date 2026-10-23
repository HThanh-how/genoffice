import { en } from './ocr-source/en'
import { vi } from './ocr-source/vi'
import { zh } from './ocr-source/zh'
import { zhTW } from './ocr-source/zh-TW'

export const ocrSourceCopy: Record<string, typeof en> = { en, vi, zh, 'zh-TW': zhTW }
