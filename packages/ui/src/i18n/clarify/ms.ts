import type zh from './zh'

const strings = {
  aiActionStep: 'Langkah {step}/{total}: {text} (Esc untuk batal)',
  aiActionApprove: 'Benarkan',
  aiActionDeny: 'Tolak',
  aiActionConfirm: 'Benarkan tindakan ini?',
  aiActionIndex: 'Buka indeks',
  aiActionSettings: 'Buka tetapan',
  aiActionNewChat: 'Mulakan sembang baharu',
  aiActionPrint: 'Buka Fail → Cetak',
  aiActionExportPdf: 'Eksport PDF',
  aiActionFile: 'Buka menu Fail',
  aiActionHandoff: 'Teruskan dalam dialog; hasil bergantung pada pilihan anda.',
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
