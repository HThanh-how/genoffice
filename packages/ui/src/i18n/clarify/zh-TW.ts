import type zh from './zh'

const strings = {
  aiClarifyTitle: '先確認幾個問題，讓頁面更貼合你的需求',
  aiClarifyDecide: '幫我決定',
  aiClarifyDecideAnswer: '（幫我決定）',
  aiClarifyMulti: '可複選',
  aiClarifyNext: '下一題',
  aiClarifyPrev: '上一題',
  aiClarifyOther: '其他(可填寫)',
  aiClarifySelected: '已選 {n} 項',
  aiClarifySkip: '略過問卷',
  aiClarifySubmit: '傳送',
} satisfies Record<keyof typeof zh, string>

export default strings
