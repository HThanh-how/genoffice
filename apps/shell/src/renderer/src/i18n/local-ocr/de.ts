import type { zh } from './zh'

export const copy = {
  enable: 'Lokale OCR',
  engine: 'Lokale OCR-Engine',
  auto: 'Automatisch',
  tesseract: 'Nur Tesseract',
  vision: 'Apple Vision (TrueOCR, Tesseract als Ersatz)',
  autoHint: 'Automatisch (TrueOCR, Tesseract als Ersatz; unter macOS zuerst Apple Vision)',
} satisfies Record<keyof typeof zh, string>
