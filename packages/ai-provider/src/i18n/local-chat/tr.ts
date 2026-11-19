import { copy as zh } from './zh'
export const copy = {
  title: 'Yerel sohbet modeli',
  missing: 'İndirilmedi',
  checking: 'SHA-256 doğrulanıyor…',
  downloading: 'İndiriliyor %{n}',
  paused: 'Duraklatıldı %{n}',
  ready: 'Hazır',
  error: 'Hata',
  download: 'İndir',
  cancel: 'İptal',
  resume: 'Devam et',
  remove: 'Modeli sil',
  keepHot: 'Bellekte tut (dakika)',
  thinking: 'Akıl yürütme (daha yavaş)',
  autoDownload: 'Gerektiğinde modeli indir',
  advanced: 'Gelişmiş',
  threads: 'CPU iş parçacıkları',
  gpu: 'Arka uç',
  context: 'Bağlam tokenleri',
  limits:
    'Yalnızca metin, görseller henüz desteklenmiyor. Kodlama, uzun sohbetler veya karmaşık akıl yürütme için önerilmez.',
  license:
    'LFM Open License v1.0: yıllık gelir 10 milyon USD üzerindeyse Liquid AI ile ayrı anlaşma gerekir.',
  gpuWarning:
    'Varsayılan CPU. Testte Vulkan, Radeon 780M üzerinde çöktü; GPU için ayrıca uyumlu çalışma ortamı kurulmalıdır.',
  offline: 'Çevrimdışı. Yerel modeli indirmek için bağlanın.',
  metered: 'Ölçülü ağ: otomatik indirme duraklatıldı. Devam etmek için elle indirin.',
} satisfies Record<keyof typeof zh, string>
