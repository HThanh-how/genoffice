import type { zh } from './zh'

export const copy = {
  appearance: '外觀',
  ai: 'AI 面板',
  files: '檔案與儲存',
  legacy: '舊版 Office 檔案',
  legacyHint: '.doc 與 .ppt 轉換',
  privacy: '隱私與剪貼簿',
  opening: '開啟動畫',
  openingHint: '開啟檔案時播放的場景',
  appearanceHint: '語言、佈景主題與閱讀舒適度',
  aiHint: '讓助理配合你的工作方式',
  filesHint: '預設資料夾與自動儲存',
  privacyHint: '選擇應用程式記憶和分享的資料',
  modelHint: '選擇供應商並設定連線',
  searchHint: '選擇助理尋找資訊來源的方式',
  mediaProviderHint: '為此功能選擇供應商和模型',
  aboutTitle: '應用程式與更新',
  aboutHint: '版本、更新來源與發佈通道',
  studioHint: '選擇、預覽和自訂開啟卡片',
  advancedHint: '匯入並預覽自己的 HTML 場景',
} satisfies Record<keyof typeof zh, string>
