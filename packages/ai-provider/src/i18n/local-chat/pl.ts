import { copy as zh } from './zh'
export const copy = {
  noReply: 'Model lokalny nie odpowiedział po ponownej próbie. Spróbuj jeszcze raz.',
  title: 'Lokalny model czatu',
  missing: 'Nie pobrano',
  checking: 'Sprawdzanie SHA-256…',
  downloading: 'Pobieranie {n}%',
  paused: 'Wstrzymano {n}%',
  ready: 'Gotowy',
  error: 'Błąd',
  download: 'Pobierz',
  cancel: 'Anuluj',
  resume: 'Wznów',
  remove: 'Usuń model',
  keepHot: 'Zachowaj w pamięci (minuty)',
  thinking: 'Rozumowanie (wolniejsze)',
  autoDownload: 'Pobieraj model w razie potrzeby',
  advanced: 'Zaawansowane',
  threads: 'Wątki CPU',
  gpu: 'Silnik',
  context: 'Tokeny kontekstu',
  limits:
    'Tylko tekst, bez obsługi obrazów. Niezalecany do kodu, długich rozmów lub złożonego rozumowania.',
  license:
    'LFM Open License v1.0: roczny przychód ponad 10 mln USD wymaga osobnej umowy z Liquid AI.',
  gpuWarning:
    'Domyślnie CPU. Vulkan uległ awarii na Radeon 780M w testach; GPU wymaga osobno zainstalowanego zgodnego środowiska.',
  offline: 'Brak sieci. Połącz się, aby pobrać lokalny model.',
  metered: 'Sieć taryfowa: automatyczne pobieranie wstrzymane. Pobierz ręcznie, aby kontynuować.',
} satisfies Record<keyof typeof zh, string>
