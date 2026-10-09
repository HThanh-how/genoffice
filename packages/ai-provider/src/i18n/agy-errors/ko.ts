import type { zh } from './zh'

export const ko = {
  agyErrQuota:
    'Antigravity 사용량 한도를 모두 사용했습니다. 한도가 초기화될 때까지 기다리거나 설정에서 다른 모델 또는 제공업체로 전환하세요.',
  agyErrQuotaAt:
    'Antigravity 사용량 한도를 모두 사용했습니다. 초기화 시각: {time}. 한도가 초기화될 때까지 기다리거나 설정에서 다른 모델 또는 제공업체로 전환하세요.',
  agyErrAuth:
    'Antigravity에 로그인되어 있지 않거나 세션이 만료되었습니다. 설정 → AI 모델에서 다시 로그인하세요.',
} satisfies Record<keyof typeof zh, string>
