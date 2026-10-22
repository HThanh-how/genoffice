import type zh from './zh'

const strings = {
  aiClarifyTitle: 'Beberapa soalan ringkas untuk menyesuaikan halaman dengan keperluan anda',
  aiClarifyDecide: 'Putuskan untuk saya',
  aiClarifyDecideAnswer: '(putuskan untuk saya)',
  aiClarifyMulti: 'Pilihan berbilang',
  aiClarifyNext: 'Seterusnya',
  aiClarifyPrev: 'Sebelumnya',
  aiClarifyOther: 'Lain-lain (taip sendiri)',
  aiClarifySelected: '{n} dipilih',
  aiClarifySkip: 'Langkau tinjauan',
  aiClarifySubmit: 'Hantar',
} satisfies Record<keyof typeof zh, string>

export default strings
