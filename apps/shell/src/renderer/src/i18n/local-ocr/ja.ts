import type { zh } from './zh'

export const copy = {
  enable: 'ローカル OCR',
  engine: 'ローカル OCR エンジン',
  auto: '自動',
  tesseract: 'Tesseract のみ',
  vision: 'Apple Vision（予備：TrueOCR、Tesseract）',
  autoHint: '自動（TrueOCR、予備に Tesseract。macOS は Apple Vision 優先）',
} satisfies Record<keyof typeof zh, string>
