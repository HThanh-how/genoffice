import type { zh } from './zh'

export const strings = {
  title: 'このファイル操作を許可しますか？',
  approve: '承認',
  deny: '拒否',
  create_folder: 'フォルダーを作成',
  move_file: 'ファイルを移動・名前変更',
  delete_file: 'OS のごみ箱へ移動',
  list_folder: 'フォルダーを一覧表示',
  merge_documents: '文書を新しいファイルに結合',
  export_pdf: '保存済みファイルを PDF に出力',
} satisfies Record<keyof typeof zh, string>
