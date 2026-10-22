import type { zh } from './zh'

export const strings = {
  title: 'Benarkan tindakan fail ini?',
  approve: 'Luluskan',
  deny: 'Tolak',
  create_folder: 'Cipta folder',
  move_file: 'Pindah atau namakan semula fail',
  delete_file: 'Pindah ke tong sampah sistem',
  list_folder: 'Senaraikan folder',
  merge_documents: 'Gabungkan dokumen ke fail baharu',
  export_pdf: 'Eksport fail tersimpan ke PDF',
} satisfies Record<keyof typeof zh, string>
