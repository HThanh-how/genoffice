import type { zh } from './zh'

export const strings = {
  title: 'Engedélyezed ezt a fájlműveletet?',
  approve: 'Jóváhagyás',
  deny: 'Elutasítás',
  create_folder: 'Mappa létrehozása',
  move_file: 'Fájl áthelyezése vagy átnevezése',
  delete_file: 'Áthelyezés a kukába',
  list_folder: 'Mappa listázása',
  merge_documents: 'Dokumentumok egyesítése új fájlba',
  export_pdf: 'Mentett fájl exportálása PDF-be',
} satisfies Record<keyof typeof zh, string>
