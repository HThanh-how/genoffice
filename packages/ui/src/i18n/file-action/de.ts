import type { zh } from './zh'

export const strings = {
  title: 'Diese Dateiaktion erlauben?',
  approve: 'Genehmigen',
  deny: 'Ablehnen',
  create_folder: 'Ordner erstellen',
  move_file: 'Datei verschieben oder umbenennen',
  delete_file: 'In den Systempapierkorb verschieben',
  list_folder: 'Ordner auflisten',
  merge_documents: 'Dokumente in einer neuen Datei zusammenführen',
  export_pdf: 'Gespeicherte Datei als PDF exportieren',
} satisfies Record<keyof typeof zh, string>
