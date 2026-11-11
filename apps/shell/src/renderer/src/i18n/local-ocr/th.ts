import type { zh } from './zh'

export const copy = {
  enable: 'OCR ในเครื่อง',
  engine: 'เอนจิน OCR ในเครื่อง',
  auto: 'อัตโนมัติ',
  tesseract: 'Tesseract เท่านั้น',
  vision: 'Apple Vision (สำรองด้วย TrueOCR และ Tesseract)',
  autoHint: 'อัตโนมัติ (TrueOCR สำรองด้วย Tesseract; macOS ใช้ Apple Vision ก่อน)',
} satisfies Record<keyof typeof zh, string>
