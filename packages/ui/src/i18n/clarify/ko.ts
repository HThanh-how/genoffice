import type zh from './zh'

const strings = {
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
