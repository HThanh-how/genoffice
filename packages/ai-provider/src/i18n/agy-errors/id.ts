import type { zh } from './zh'

export const id = {
  agyErrQuota:
    'Kuota penggunaan Antigravity Anda sudah habis. Tunggu hingga direset, atau beralih ke model atau penyedia lain di Pengaturan.',
  agyErrQuotaAt:
    'Kuota penggunaan Antigravity Anda sudah habis. Direset pada: {time}. Tunggu hingga direset, atau beralih ke model atau penyedia lain di Pengaturan.',
  agyErrAuth:
    'Antigravity belum masuk, atau sesinya telah berakhir. Masuk lagi di Pengaturan → Model AI.',
} satisfies Record<keyof typeof zh, string>
