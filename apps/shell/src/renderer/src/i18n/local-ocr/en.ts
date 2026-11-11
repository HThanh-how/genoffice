import type { zh } from './zh'

export const copy = {
  enable: 'Local OCR',
  engine: 'Local OCR engine',
  auto: 'Automatic',
  tesseract: 'Tesseract only',
  vision: 'Apple Vision (TrueOCR, Tesseract fallback)',
  autoHint: 'Automatic (TrueOCR, Tesseract fallback; Apple Vision first on macOS)',
} satisfies Record<keyof typeof zh, string>
