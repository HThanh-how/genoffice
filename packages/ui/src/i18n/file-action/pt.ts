import type { zh } from './zh'

export const strings = {
  title: 'Permitir esta operação de ficheiro?',
  approve: 'Aprovar',
  deny: 'Negar',
  create_folder: 'Criar pasta',
  move_file: 'Mover ou renomear ficheiro',
  delete_file: 'Mover para a reciclagem do sistema',
  list_folder: 'Listar pasta',
  merge_documents: 'Mesclar documentos em um novo arquivo',
  export_pdf: 'Exportar ficheiro guardado para PDF',
} satisfies Record<keyof typeof zh, string>
