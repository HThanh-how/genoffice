import type { zh } from './zh'

export const fr = {
  agyErrQuota:
    'Votre quota d’utilisation Antigravity est épuisé. Attendez sa réinitialisation ou passez à un autre modèle ou fournisseur dans les paramètres.',
  agyErrQuotaAt:
    'Votre quota d’utilisation Antigravity est épuisé. Réinitialisation : {time}. Attendez la réinitialisation ou passez à un autre modèle ou fournisseur dans les paramètres.',
  agyErrAuth:
    'Antigravity n’est pas connecté, ou sa session a expiré. Reconnectez-vous dans Paramètres → Modèle IA.',
} satisfies Record<keyof typeof zh, string>
