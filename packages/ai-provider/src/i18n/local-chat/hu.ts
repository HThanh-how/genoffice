import { copy as zh } from './zh'
export const copy = {
  noReply: 'A helyi modell az újrapróbálkozás után sem válaszolt. Próbálja újra.',
  title: 'Helyi csevegőmodell',
  missing: 'Nincs letöltve',
  checking: 'SHA-256 ellenőrzése…',
  downloading: 'Letöltés: {n}%',
  paused: 'Szünetel: {n}%',
  ready: 'Kész',
  error: 'Hiba',
  download: 'Letöltés',
  cancel: 'Mégse',
  resume: 'Folytatás',
  remove: 'Modell törlése',
  keepHot: 'Memóriában tartás (perc)',
  thinking: 'Következtetés (lassabb)',
  autoDownload: 'Modell automatikus letöltése',
  advanced: 'Speciális',
  threads: 'CPU szálak',
  gpu: 'Háttérrendszer',
  context: 'Kontextustokenek',
  limits:
    'Csak szöveg, képek még nem támogatottak. Programozáshoz, hosszú beszélgetésekhez és összetett következtetéshez nem ajánlott.',
  license:
    'LFM Open License v1.0: évi 10 millió USD feletti bevételhez külön megállapodás kell a Liquid AI vállalattal.',
  gpuWarning:
    'Alapértelmezés: CPU. A Vulkan összeomlott Radeon 780M-en a tesztben; a GPU-hoz külön kompatibilis futtatókörnyezet kell.',
  offline: 'Nincs hálózat. Csatlakozzon a helyi modell letöltéséhez.',
  metered:
    'Forgalomdíjas hálózat: az automatikus letöltés szünetel. Indítsa el kézzel a letöltést.',
} satisfies Record<keyof typeof zh, string>
