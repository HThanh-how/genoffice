import type { zh } from './zh'

export const copy = {
  enable: 'OCR local',
  engine: 'Motor de OCR local',
  auto: 'Automático',
  tesseract: 'Solo Tesseract',
  vision: 'Apple Vision (TrueOCR, Tesseract de respaldo)',
  autoHint: 'Automático (TrueOCR, Tesseract de respaldo; Apple Vision primero en macOS)',
} satisfies Record<keyof typeof zh, string>
