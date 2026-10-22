import type { zh } from './zh'

export const strings = {
  title: 'Izinkan tindakan berkas ini?',
  approve: 'Setujui',
  deny: 'Tolak',
  create_folder: 'Buat folder',
  move_file: 'Pindahkan atau ganti nama berkas',
  delete_file: 'Pindahkan ke tempat sampah sistem',
  list_folder: 'Daftar folder',
  merge_documents: 'Gabungkan dokumen ke file baru',
  export_pdf: 'Ekspor berkas tersimpan ke PDF',
} satisfies Record<keyof typeof zh, string>
