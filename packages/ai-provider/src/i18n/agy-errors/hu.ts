import type { zh } from './zh'

export const hu = {
  agyErrQuota:
    'Az Antigravity használati kerete elfogyott. Várd meg a visszaállítását, vagy válts másik modellre vagy szolgáltatóra a Beállításokban.',
  agyErrQuotaAt:
    'Az Antigravity használati kerete elfogyott, és ekkor áll vissza: {time}. Várd meg a visszaállítását, vagy válts másik modellre vagy szolgáltatóra a Beállításokban.',
  agyErrAuth:
    'Az Antigravity nincs bejelentkezve, vagy lejárt a munkamenete. Jelentkezz be újra a Beállítások → AI-modell oldalon.',
} satisfies Record<keyof typeof zh, string>
