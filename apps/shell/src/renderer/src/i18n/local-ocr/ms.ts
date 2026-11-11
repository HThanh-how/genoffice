import type { zh } from './zh'

export const copy = {
  enable: 'OCR setempat',
  engine: 'Enjin OCR setempat',
  auto: 'Automatik',
  tesseract: 'Tesseract sahaja',
  vision: 'Apple Vision (sandaran TrueOCR, Tesseract)',
  autoHint: 'Automatik (TrueOCR, sandaran Tesseract; Apple Vision dahulu pada macOS)',
} satisfies Record<keyof typeof zh, string>
