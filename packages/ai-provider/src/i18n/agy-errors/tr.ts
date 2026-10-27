import type { zh } from './zh'

export const tr = {
  agyErrQuota:
    'Antigravity kullanım kotanız doldu. Kotanın sıfırlanmasını bekleyin veya Ayarlar’dan başka bir modele ya da sağlayıcıya geçin.',
  agyErrQuotaAt:
    'Antigravity kullanım kotanız doldu. Sıfırlanma zamanı: {time}. Kotanın sıfırlanmasını bekleyin veya Ayarlar’dan başka bir modele ya da sağlayıcıya geçin.',
  agyErrAuth:
    'Antigravity oturumu açık değil veya oturumun süresi doldu. Ayarlar → AI Modelleri bölümünden yeniden oturum açın.',
} satisfies Record<keyof typeof zh, string>
