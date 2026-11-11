import type { zh } from './zh'

export const copy = {
  enable: 'OCR lokal',
  engine: 'Mesin OCR lokal',
  auto: 'Otomatis',
  tesseract: 'Hanya Tesseract',
  vision: 'Apple Vision (cadangan TrueOCR, Tesseract)',
  autoHint: 'Otomatis (TrueOCR, cadangan Tesseract; Apple Vision lebih dulu di macOS)',
} satisfies Record<keyof typeof zh, string>
