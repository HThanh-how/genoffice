import type { zh } from './zh'

export const copy = {
  enable: 'Локальное OCR',
  engine: 'Локальный движок OCR',
  auto: 'Автоматически',
  tesseract: 'Только Tesseract',
  vision: 'Apple Vision (резерв: TrueOCR, Tesseract)',
  autoHint: 'Автоматически (TrueOCR, резервный Tesseract; на macOS сначала Apple Vision)',
} satisfies Record<keyof typeof zh, string>
