import type { zh } from './zh'

export const copy = {
  enable: 'OCR local',
  engine: 'Motor de OCR local',
  auto: 'Automático',
  tesseract: 'Apenas Tesseract',
  vision: 'Apple Vision (TrueOCR, Tesseract de reserva)',
  autoHint: 'Automático (TrueOCR, Tesseract de reserva; Apple Vision primeiro no macOS)',
} satisfies Record<keyof typeof zh, string>
