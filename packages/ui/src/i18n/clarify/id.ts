import type zh from './zh'

const strings = {
  aiActionStep: 'Langkah {step}/{total}: {text} (Esc untuk batal)',
  aiActionApprove: 'Izinkan',
  aiActionDeny: 'Tolak',
  aiActionConfirm: 'Izinkan tindakan ini?',
  aiActionIndex: 'Buka indeks',
  aiActionSettings: 'Buka pengaturan',
  aiActionNewChat: 'Mulai obrolan baru',
  aiActionPrint: 'Buka Berkas → Cetak',
  aiActionExportPdf: 'Ekspor PDF',
  aiActionFile: 'Buka menu Berkas',
  aiActionHandoff: 'Lanjutkan di dialog; hasil bergantung pada pilihan Anda.',
  aiClarifyTitle: 'Beberapa pertanyaan singkat agar halaman lebih sesuai kebutuhan Anda',
  aiClarifyDecide: 'Putuskan untuk saya',
  aiClarifyDecideAnswer: '(putuskan untuk saya)',
  aiClarifyMulti: 'Pilih beberapa',
  aiClarifyNext: 'Berikutnya',
  aiClarifyPrev: 'Sebelumnya',
  aiClarifyOther: 'Lainnya (isi sendiri)',
  aiClarifySelected: '{n} dipilih',
  aiClarifySkip: 'Lewati survei',
  aiClarifySubmit: 'Kirim',
} satisfies Record<keyof typeof zh, string>

export default strings
