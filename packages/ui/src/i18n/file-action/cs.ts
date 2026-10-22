import type { zh } from './zh'

export const strings = {
  title: 'Povolit tuto operaci se souborem?',
  approve: 'Schválit',
  deny: 'Zamítnout',
  create_folder: 'Vytvořit složku',
  move_file: 'Přesunout nebo přejmenovat soubor',
  delete_file: 'Přesunout do systémového koše',
  list_folder: 'Vypsat složku',
  merge_documents: 'Sloučit dokumenty do nového souboru',
  export_pdf: 'Exportovat uložený soubor do PDF',
} satisfies Record<keyof typeof zh, string>
