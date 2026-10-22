import type zh from './zh'

const strings = {
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
