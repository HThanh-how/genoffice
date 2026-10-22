import type zh from './zh'

const strings = {
  aiActionStep: 'ステップ {step}/{total}: {text}（Esc でキャンセル）',
  aiActionApprove: '許可',
  aiActionDeny: '拒否',
  aiActionConfirm: 'この操作を許可しますか？',
  aiActionIndex: 'インデックスを開く',
  aiActionSettings: '設定を開く',
  aiActionNewChat: '新しいチャットを開始',
  aiActionPrint: 'ファイル → 印刷を開く',
  aiActionExportPdf: 'PDF に書き出す',
  aiActionFile: 'ファイルメニューを開く',
  aiActionHandoff: 'ダイアログで続行してください。結果は選択内容によって異なります。',
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
