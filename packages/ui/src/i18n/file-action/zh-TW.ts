import type { zh } from './zh'

export const strings = {
  title: '允許此檔案操作？',
  approve: '核准',
  deny: '拒絕',
  create_folder: '建立資料夾',
  move_file: '移動或重新命名檔案',
  delete_file: '移至系統垃圾桶',
  list_folder: '列出資料夾',
  merge_documents: '將文件合併為新檔案',
  export_pdf: '將已儲存的檔案匯出為 PDF',
} satisfies Record<keyof typeof zh, string>
