import { copy as zh } from './zh'
export const copy = {
  noReply: 'Model setempat tidak memberikan jawapan selepas percubaan semula. Sila cuba lagi.',
  title: 'Model sembang setempat',
  missing: 'Belum dimuat turun',
  checking: 'Mengesahkan SHA-256…',
  downloading: 'Memuat turun {n}%',
  paused: 'Dijeda {n}%',
  ready: 'Sedia',
  error: 'Ralat',
  download: 'Muat turun',
  cancel: 'Batal',
  resume: 'Sambung',
  remove: 'Padam model',
  keepHot: 'Kekalkan dalam memori (minit)',
  thinking: 'Penaakulan (lebih perlahan)',
  autoDownload: 'Muat turun model apabila diperlukan',
  advanced: 'Lanjutan',
  threads: 'Thread CPU',
  gpu: 'Backend',
  context: 'Token konteks',
  limits:
    'Teks sahaja, imej belum disokong. Tidak disyorkan untuk kod, perbualan panjang atau penaakulan kompleks.',
  license:
    'LFM Open License v1.0: hasil tahunan melebihi USD 10 juta memerlukan perjanjian berasingan dengan Liquid AI.',
  gpuWarning:
    'CPU secara lalai. Vulkan ranap pada Radeon 780M semasa ujian; GPU memerlukan runtime serasi yang dipasang berasingan.',
  offline: 'Luar talian. Sambung untuk memuat turun model setempat.',
  metered:
    'Rangkaian bermeter: muat turun automatik dijeda. Muat turun secara manual untuk meneruskan.',
} satisfies Record<keyof typeof zh, string>
