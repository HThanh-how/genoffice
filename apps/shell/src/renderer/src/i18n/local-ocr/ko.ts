import type { zh } from './zh'

export const copy = {
  enable: '로컬 OCR',
  engine: '로컬 OCR 엔진',
  auto: '자동',
  tesseract: 'Tesseract만 사용',
  vision: 'Apple Vision (TrueOCR, Tesseract 대체)',
  autoHint: '자동 (TrueOCR, Tesseract 대체; macOS는 Apple Vision 우선)',
} satisfies Record<keyof typeof zh, string>
