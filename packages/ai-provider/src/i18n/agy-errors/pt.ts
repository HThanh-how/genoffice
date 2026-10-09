import type { zh } from './zh'

export const pt = {
  agyErrQuota:
    'A cota de uso do Antigravity acabou. Aguarde a redefinição ou mude para outro modelo ou provedor nas Configurações.',
  agyErrQuotaAt:
    'A cota de uso do Antigravity acabou. Redefinição: {time}. Aguarde a redefinição ou mude para outro modelo ou provedor nas Configurações.',
  agyErrAuth:
    'O Antigravity não está conectado ou a sessão expirou. Entre novamente em Configurações → Modelo de IA.',
} satisfies Record<keyof typeof zh, string>
