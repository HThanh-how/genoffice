import type { zh } from './zh'

export const strings = {
  title: 'Bu dosya işlemine izin verilsin mi?',
  approve: 'Onayla',
  deny: 'Reddet',
  create_folder: 'Klasör oluştur',
  move_file: 'Dosyayı taşı veya yeniden adlandır',
  delete_file: 'İşletim sistemi çöp kutusuna taşı',
  list_folder: 'Klasörü listele',
  merge_documents: 'Belgeleri yeni bir dosyada birleştir',
  export_pdf: 'Kaydedilmiş dosyayı PDF olarak dışa aktar',
} satisfies Record<keyof typeof zh, string>
