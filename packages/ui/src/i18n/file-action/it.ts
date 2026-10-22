import type { zh } from './zh'

export const strings = {
  title: 'Consentire questa operazione sul file?',
  approve: 'Approva',
  deny: 'Nega',
  create_folder: 'Crea cartella',
  move_file: 'Sposta o rinomina file',
  delete_file: 'Sposta nel cestino di sistema',
  list_folder: 'Elenca cartella',
  export_pdf: 'Esporta il file salvato in PDF',
} satisfies Record<keyof typeof zh, string>
