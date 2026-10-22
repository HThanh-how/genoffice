import type { zh } from './zh'

export const strings = {
  title: 'Autoriser cette opération sur le fichier ?',
  approve: 'Approuver',
  deny: 'Refuser',
  create_folder: 'Créer un dossier',
  move_file: 'Déplacer ou renommer le fichier',
  delete_file: 'Déplacer dans la corbeille du système',
  list_folder: 'Lister le dossier',
  export_pdf: 'Exporter le fichier enregistré en PDF',
} satisfies Record<keyof typeof zh, string>
