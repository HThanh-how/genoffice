import type zh from './zh'

const strings = {
  aiActionStep: '第 {step}/{total} 步：{text}（Esc 取消）',
  aiActionApprove: '允許',
  aiActionDeny: '拒絕',
  aiActionConfirm: '允許此操作？',
  aiActionIndex: '開啟索引',
  aiActionSettings: '開啟設定',
  aiActionNewChat: '開始新對話',
  aiActionPrint: '開啟檔案 → 列印',
  aiActionExportPdf: '匯出 PDF',
  aiActionFile: '開啟檔案選單',
  aiActionHandoff: '請在對話框中繼續；結果取決於您的選擇。',
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
