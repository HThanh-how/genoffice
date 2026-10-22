import type zh from './zh'

const strings = {
  aiClarifyTitle: 'ご要望に合ったページにするため、いくつか確認させてください',
  aiClarifyDecide: 'おまかせ',
  aiClarifyDecideAnswer: '（おまかせ）',
  aiClarifyMulti: '複数選択',
  aiClarifyNext: '次へ',
  aiClarifyPrev: '前へ',
  aiClarifyOther: 'その他（自由記入）',
  aiClarifySelected: '{n} 件選択',
  aiClarifySkip: 'アンケートをスキップ',
  aiClarifySubmit: '送信',
} satisfies Record<keyof typeof zh, string>

export default strings
