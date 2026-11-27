import { copy as zh } from './zh'
export const copy = {
  noReply: 'Het lokale model gaf ook na een nieuwe poging geen antwoord. Probeer het opnieuw.',
  title: 'Lokaal chatmodel',
  missing: 'Niet gedownload',
  checking: 'SHA-256 controleren…',
  downloading: 'Downloaden {n}%',
  paused: 'Gepauzeerd {n}%',
  ready: 'Gereed',
  error: 'Fout',
  download: 'Downloaden',
  cancel: 'Annuleren',
  resume: 'Hervatten',
  remove: 'Model verwijderen',
  keepHot: 'In geheugen houden (minuten)',
  thinking: 'Redeneren (langzamer)',
  autoDownload: 'Model downloaden indien nodig',
  advanced: 'Geavanceerd',
  threads: 'CPU-threads',
  gpu: 'Backend',
  context: 'Contexttokens',
  limits:
    'Alleen tekst, nog geen afbeeldingen. Niet aanbevolen voor code, lange gesprekken of complexe redeneringen.',
  license:
    'LFM Open License v1.0: boven 10 miljoen USD jaaromzet is een aparte overeenkomst met Liquid AI vereist.',
  gpuWarning:
    'Standaard CPU. Vulkan crashte op Radeon 780M tijdens tests; GPU-backends vereisen een apart geïnstalleerde compatibele runtime.',
  offline: 'Offline. Maak verbinding om het lokale model te downloaden.',
  metered:
    'Verbinding met datalimiet: automatisch downloaden gepauzeerd. Download handmatig om door te gaan.',
} satisfies Record<keyof typeof zh, string>
