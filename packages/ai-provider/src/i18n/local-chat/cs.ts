import { copy as zh } from './zh'
export const copy = {
  title: 'Místní model chatu',
  missing: 'Nestaženo',
  checking: 'Ověřování SHA-256…',
  downloading: 'Stahování {n}%',
  paused: 'Pozastaveno {n}%',
  ready: 'Připraveno',
  error: 'Chyba',
  download: 'Stáhnout',
  cancel: 'Zrušit',
  resume: 'Pokračovat',
  remove: 'Smazat model',
  keepHot: 'Ponechat v paměti (minuty)',
  thinking: 'Uvažování (pomalejší)',
  autoDownload: 'Stáhnout model podle potřeby',
  advanced: 'Pokročilé',
  threads: 'Vlákna CPU',
  gpu: 'Backend',
  context: 'Tokeny kontextu',
  limits:
    'Pouze text, obrázky zatím nejsou podporovány. Nedoporučeno pro kód, dlouhé rozhovory či složité uvažování.',
  license:
    'LFM Open License v1.0: roční příjmy nad 10 milionů USD vyžadují samostatnou dohodu s Liquid AI.',
  gpuWarning:
    'Výchozí je CPU. Vulkan při testu na Radeon 780M havaroval; GPU vyžaduje samostatně nainstalované kompatibilní prostředí.',
  offline: 'Offline. Připojte se ke stažení místního modelu.',
  metered: 'Zpoplatněné připojení: automatické stahování pozastaveno. Pokračujte ručním stažením.',
} satisfies Record<keyof typeof zh, string>
