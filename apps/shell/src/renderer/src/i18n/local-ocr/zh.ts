export const copy = {
  enable: '本机 OCR',
  engine: '本机 OCR 引擎',
  auto: '自动',
  tesseract: '仅 Tesseract',
  vision: 'Apple Vision（备用：TrueOCR、Tesseract）',
  autoHint: '自动（TrueOCR，Tesseract 备用；macOS 优先使用 Apple Vision）',
} as const
export { copy as zh }
