import type { zh } from './zh'

export const copy = {
  enable: 'Lokale OCR',
  engine: 'Lokale OCR-engine',
  auto: 'Automatisch',
  tesseract: 'Alleen Tesseract',
  vision: 'Apple Vision (TrueOCR, Tesseract als reserve)',
  autoHint: 'Automatisch (TrueOCR, Tesseract als reserve; Apple Vision eerst op macOS)',
} satisfies Record<keyof typeof zh, string>
