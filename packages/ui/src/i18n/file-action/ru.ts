import type { zh } from './zh'

export const strings = {
  title: 'Разрешить это действие с файлом?',
  approve: 'Разрешить',
  deny: 'Отклонить',
  create_folder: 'Создать папку',
  move_file: 'Переместить или переименовать файл',
  delete_file: 'Переместить в системную корзину',
  list_folder: 'Список папки',
  merge_documents: 'Объединить документы в новый файл',
  export_pdf: 'Экспорт сохранённого файла в PDF',
} satisfies Record<keyof typeof zh, string>
