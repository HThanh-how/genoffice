import type { zh } from './zh'

export const copy = {
  enable: 'OCR محلي',
  engine: 'محرك OCR المحلي',
  auto: 'تلقائي',
  tesseract: 'Tesseract فقط',
  vision: 'Apple Vision (ثم TrueOCR وTesseract)',
  autoHint: 'تلقائي (TrueOCR ثم Tesseract؛ Apple Vision أولاً على macOS)',
} satisfies Record<keyof typeof zh, string>
