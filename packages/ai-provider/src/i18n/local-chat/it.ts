import { copy as zh } from './zh'
export const copy = {
  title: 'Modello chat locale',
  missing: 'Non scaricato',
  checking: 'Verifica SHA-256…',
  downloading: 'Download {n}%',
  paused: 'In pausa {n}%',
  ready: 'Pronto',
  error: 'Errore',
  download: 'Scarica',
  cancel: 'Annulla',
  resume: 'Riprendi',
  remove: 'Elimina modello',
  keepHot: 'Mantieni in memoria (minuti)',
  thinking: 'Ragionamento (più lento)',
  autoDownload: 'Scarica il modello quando serve',
  advanced: 'Avanzate',
  threads: 'Thread CPU',
  gpu: 'Motore',
  context: 'Token di contesto',
  limits:
    'Solo testo, immagini non ancora supportate. Sconsigliato per codice, lunghe conversazioni o ragionamenti complessi.',
  license:
    'LFM Open License v1.0: ricavi annui oltre 10 milioni USD richiedono un accordo separato con Liquid AI.',
  gpuWarning:
    'CPU predefinita. Vulkan si è arrestato su Radeon 780M nei test; i motori GPU richiedono un ambiente compatibile installato a parte.',
  offline: 'Offline. Connettiti per scaricare il modello locale.',
  metered: 'Rete a consumo: download automatico in pausa. Scarica manualmente per continuare.',
} satisfies Record<keyof typeof zh, string>
