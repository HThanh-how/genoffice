import type zh from './zh'

const strings = {
  aiActionStep: '단계 {step}/{total}: {text} (Esc로 취소)',
  aiActionApprove: '허용',
  aiActionDeny: '거부',
  aiActionConfirm: '이 작업을 허용할까요?',
  aiActionIndex: '색인 열기',
  aiActionSettings: '설정 열기',
  aiActionNewChat: '새 채팅 시작',
  aiActionPrint: '파일 → 인쇄 열기',
  aiActionExportPdf: 'PDF로 내보내기',
  aiActionFile: '파일 메뉴 열기',
  aiActionHandoff: '대화 상자에서 계속하세요. 결과는 선택에 따라 달라집니다.',
  aiClarifyTitle: '몇 가지 질문에 답하면 요구에 더 맞는 페이지를 만들 수 있습니다',
  aiClarifyDecide: '알아서 결정',
  aiClarifyDecideAnswer: '(알아서 결정)',
  aiClarifyMulti: '복수 선택',
  aiClarifyNext: '다음',
  aiClarifyPrev: '이전',
  aiClarifyOther: '기타(직접 입력)',
  aiClarifySelected: '{n}개 선택',
  aiClarifySkip: '설문 건너뛰기',
  aiClarifySubmit: '전송',
} satisfies Record<keyof typeof zh, string>

export default strings
