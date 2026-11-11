import type { zh } from './zh'

export const copy = {
  enable: 'OCR trên máy',
  engine: 'Engine OCR trên máy',
  auto: 'Tự động',
  tesseract: 'Chỉ Tesseract',
  vision: 'Apple Vision (TrueOCR, Tesseract dự phòng)',
  autoHint: 'Tự động (TrueOCR, Tesseract dự phòng; macOS ưu tiên Apple Vision)',
} satisfies Record<keyof typeof zh, string>
