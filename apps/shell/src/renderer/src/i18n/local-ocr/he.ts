import type { zh } from './zh'

export const copy = {
  enable: 'OCR מקומי',
  engine: 'מנוע OCR מקומי',
  auto: 'אוטומטי',
  tesseract: 'Tesseract בלבד',
  vision: 'Apple Vision (גיבוי TrueOCR ו-Tesseract)',
  autoHint: 'אוטומטי (TrueOCR וגיבוי Tesseract; ב-macOS קודם Apple Vision)',
} satisfies Record<keyof typeof zh, string>
