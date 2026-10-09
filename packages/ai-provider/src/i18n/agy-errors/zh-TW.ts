import type { zh } from './zh'

export const zhTW = {
  agyErrQuota: 'Antigravity 用量額度已用完。請等待額度重置，或在設定中切換至其他模型或服務供應商。',
  agyErrQuotaAt:
    'Antigravity 用量額度已用完。重置時間：{time}。請等待額度重置，或在設定中切換至其他模型或服務供應商。',
  agyErrAuth: 'Antigravity 尚未登入，或登入已過期。請在「設定 → AI 模型」中重新登入。',
} satisfies Record<keyof typeof zh, string>
