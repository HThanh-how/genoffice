import type { zh } from './zh'

export const strings = {
  title: 'Allow this file action?',
  approve: 'Approve',
  deny: 'Deny',
  create_folder: 'Create folder',
  move_file: 'Move or rename file',
  delete_file: 'Move to OS trash',
  list_folder: 'List folder',
  export_pdf: 'Export saved file to PDF',
} satisfies Record<keyof typeof zh, string>
