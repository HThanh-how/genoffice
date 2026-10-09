import type { zh } from './zh'

export const ru = {
  agyErrQuota:
    'Квота использования Antigravity исчерпана. Дождитесь сброса или переключитесь на другую модель или другого поставщика в настройках.',
  agyErrQuotaAt:
    'Квота использования Antigravity исчерпана. Сброс: {time}. Дождитесь сброса или переключитесь на другую модель или другого поставщика в настройках.',
  agyErrAuth:
    'Вход в Antigravity не выполнен или сеанс истёк. Войдите снова в разделе «Настройки → Модель ИИ».',
} satisfies Record<keyof typeof zh, string>
