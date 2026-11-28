import { copy as zh } from './zh'
export const copy = {
  noReply: 'Model lokal tidak memberikan jawaban setelah percobaan ulang. Silakan coba lagi.',
  title: 'Model obrolan lokal',
  missing: 'Belum diunduh',
  checking: 'Memverifikasi SHA-256…',
  downloading: 'Mengunduh {n}%',
  paused: 'Dijeda {n}%',
  ready: 'Siap',
  error: 'Kesalahan',
  download: 'Unduh',
  cancel: 'Batal',
  resume: 'Lanjutkan',
  remove: 'Hapus model',
  keepHot: 'Simpan di memori (menit)',
  thinking: 'Penalaran (lebih lambat)',
  autoDownload: 'Unduh model saat diperlukan',
  advanced: 'Lanjutan',
  threads: 'Thread CPU',
  gpu: 'Backend',
  context: 'Token konteks',
  limits:
    'Hanya teks, gambar belum didukung. Tidak disarankan untuk kode, percakapan panjang, atau penalaran rumit.',
  license:
    'LFM Open License v1.0: pendapatan tahunan di atas USD 10 juta memerlukan perjanjian terpisah dengan Liquid AI.',
  gpuWarning:
    'CPU secara bawaan. Vulkan gagal pada Radeon 780M saat pengujian; GPU memerlukan runtime kompatibel yang dipasang terpisah.',
  offline: 'Offline. Hubungkan jaringan untuk mengunduh model lokal.',
  metered: 'Jaringan berbayar: unduhan otomatis dijeda. Unduh secara manual untuk melanjutkan.',
} satisfies Record<keyof typeof zh, string>
