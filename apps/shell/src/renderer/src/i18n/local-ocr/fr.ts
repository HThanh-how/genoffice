import type { zh } from './zh'

export const copy = {
  enable: 'OCR local',
  engine: 'Moteur OCR local',
  auto: 'Automatique',
  tesseract: 'Tesseract uniquement',
  vision: 'Apple Vision (TrueOCR, Tesseract en secours)',
  autoHint: 'Automatique (TrueOCR, puis Tesseract en secours ; Apple Vision en premier sur macOS)',
} satisfies Record<keyof typeof zh, string>
