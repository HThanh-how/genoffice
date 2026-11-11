import type { zh } from './zh'

export const copy = {
  enable: '本機 OCR',
  engine: '本機 OCR 引擎',
  auto: '自動',
  tesseract: '僅 Tesseract',
  vision: 'Apple Vision（備用：TrueOCR、Tesseract）',
  autoHint: '自動（TrueOCR，Tesseract 備用；macOS 優先使用 Apple Vision）',
} satisfies Record<keyof typeof zh, string>
