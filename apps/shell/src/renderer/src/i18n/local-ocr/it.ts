import type { zh } from './zh'

export const copy = {
  enable: 'OCR locale',
  engine: 'Motore OCR locale',
  auto: 'Automatico',
  tesseract: 'Solo Tesseract',
  vision: 'Apple Vision (TrueOCR, Tesseract di riserva)',
  autoHint: 'Automatico (TrueOCR, Tesseract di riserva; Apple Vision prima su macOS)',
} satisfies Record<keyof typeof zh, string>
