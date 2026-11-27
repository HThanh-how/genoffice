import { copy as zh } from './zh'
export const copy = {
  noReply:
    'Das lokale Modell hat auch nach einem erneuten Versuch nicht geantwortet. Bitte versuchen Sie es noch einmal.',
  title: 'Lokales Chatmodell',
  missing: 'Nicht heruntergeladen',
  checking: 'SHA-256 wird geprüft…',
  downloading: 'Download {n}%',
  paused: 'Pausiert {n}%',
  ready: 'Bereit',
  error: 'Fehler',
  download: 'Herunterladen',
  cancel: 'Abbrechen',
  resume: 'Fortsetzen',
  remove: 'Modell löschen',
  keepHot: 'Geladen halten (Minuten)',
  thinking: 'Schlussfolgern (langsamer)',
  autoDownload: 'Modell bei Bedarf herunterladen',
  advanced: 'Erweitert',
  threads: 'CPU-Threads',
  gpu: 'Backend',
  context: 'Kontext-Token',
  limits:
    'Nur Text, noch keine Bilder. Nicht für Programmierung, lange Gespräche oder komplexes Schlussfolgern empfohlen.',
  license:
    'LFM Open License v1.0: Über 10 Millionen USD Jahresumsatz ist eine gesonderte Vereinbarung mit Liquid AI erforderlich.',
  gpuWarning:
    'Standard: CPU. Vulkan stürzte im Test auf Radeon 780M ab; GPU-Backends benötigen eine separat installierte kompatible Laufzeit.',
  offline: 'Offline. Zum Herunterladen des lokalen Modells verbinden.',
  metered:
    'Getaktetes Netzwerk: automatischer Modelldownload pausiert. Bitte manuell herunterladen.',
} satisfies Record<keyof typeof zh, string>
