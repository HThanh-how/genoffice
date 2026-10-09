import type { zh } from './zh'

export const de = {
  agyErrQuota:
    'Ihr Antigravity-Nutzungskontingent ist aufgebraucht. Warten Sie auf das Zurücksetzen oder wechseln Sie in den Einstellungen zu einem anderen Modell oder Anbieter.',
  agyErrQuotaAt:
    'Ihr Antigravity-Nutzungskontingent ist aufgebraucht. Zurücksetzung: {time}. Warten Sie auf das Zurücksetzen oder wechseln Sie in den Einstellungen zu einem anderen Modell oder Anbieter.',
  agyErrAuth:
    'Antigravity ist nicht angemeldet oder die Sitzung ist abgelaufen. Melden Sie sich unter Einstellungen → KI-Modell erneut an.',
} satisfies Record<keyof typeof zh, string>
