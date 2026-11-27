import { copy as zh } from './zh'
export const copy = {
  noReply: '로컬 모델이 재시도 후에도 응답하지 않았습니다. 다시 시도해 주세요.',
  title: '로컬 채팅 모델',
  missing: '다운로드 안 됨',
  checking: 'SHA-256 검증 중…',
  downloading: '다운로드 중 {n}%',
  paused: '일시 중지 {n}%',
  ready: '준비됨',
  error: '오류',
  download: '다운로드',
  cancel: '취소',
  resume: '계속',
  remove: '모델 삭제',
  keepHot: '메모리 유지 (분)',
  thinking: '추론 (느림)',
  autoDownload: '필요할 때 모델 다운로드',
  advanced: '고급',
  threads: 'CPU 스레드',
  gpu: '백엔드',
  context: '컨텍스트 토큰',
  limits:
    '텍스트만 지원하며 이미지는 아직 지원하지 않습니다. 코딩, 긴 대화, 복잡한 추론에는 권장하지 않습니다.',
  license: 'LFM Open License v1.0: 연 매출 1천만 USD 초과 시 Liquid AI와 별도 계약이 필요합니다.',
  gpuWarning:
    '기본값은 CPU입니다. 테스트에서 Radeon 780M의 Vulkan이 중단되었습니다. GPU에는 호환 런타임을 별도로 설치해야 합니다.',
  offline: '오프라인입니다. 로컬 모델을 다운로드하려면 연결하세요.',
  metered:
    '데이터 요금제 연결: 자동 다운로드가 일시 중지되었습니다. 계속하려면 수동으로 다운로드하세요.',
} satisfies Record<keyof typeof zh, string>
