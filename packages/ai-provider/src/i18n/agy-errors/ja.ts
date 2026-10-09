import type { zh } from './zh'

export const ja = {
  agyErrQuota:
    'Antigravity の使用量の上限に達しました。リセットされるまで待つか、設定で別のモデルまたはプロバイダーに切り替えてください。',
  agyErrQuotaAt:
    'Antigravity の使用量の上限に達しました。リセット: {time}。リセットされるまで待つか、設定で別のモデルまたはプロバイダーに切り替えてください。',
  agyErrAuth:
    'Antigravity にサインインしていないか、セッションの有効期限が切れています。「設定 → AI モデル」で再度サインインしてください。',
} satisfies Record<keyof typeof zh, string>
