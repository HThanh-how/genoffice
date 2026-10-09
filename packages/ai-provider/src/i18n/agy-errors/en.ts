import type { zh } from './zh'

export const en = {
  agyErrQuota:
    'Your Antigravity usage quota is used up. Wait for it to reset, or switch to another model or provider in Settings.',
  agyErrQuotaAt:
    'Your Antigravity usage quota is used up and resets at {time}. Wait for it to reset, or switch to another model or provider in Settings.',
  agyErrAuth:
    'Antigravity is not signed in, or its session has expired. Sign in again in Settings → AI Model.',
} satisfies Record<keyof typeof zh, string>
