import type { zh } from './zh'

export const strings = {
  title: '¿Permitir esta operación de archivo?',
  approve: 'Aprobar',
  deny: 'Denegar',
  create_folder: 'Crear carpeta',
  move_file: 'Mover o renombrar archivo',
  delete_file: 'Mover a la papelera del sistema',
  list_folder: 'Listar carpeta',
  export_pdf: 'Exportar el archivo guardado a PDF',
} satisfies Record<keyof typeof zh, string>
