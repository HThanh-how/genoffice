import type { zh } from './zh'

export const strings = {
  title: 'Zezwolić na tę operację na pliku?',
  approve: 'Zatwierdź',
  deny: 'Odrzuć',
  create_folder: 'Utwórz folder',
  move_file: 'Przenieś plik lub zmień nazwę',
  delete_file: 'Przenieś do kosza systemowego',
  list_folder: 'Wyświetl folder',
  merge_documents: 'Scal dokumenty w nowy plik',
  export_pdf: 'Eksportuj zapisany plik do PDF',
} satisfies Record<keyof typeof zh, string>
