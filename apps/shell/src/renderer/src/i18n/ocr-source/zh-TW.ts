import type { zh } from './zh'

export const zhTW = {
  waiting: '{root} 未連線（自 {date} 起）。{n} 個檔案正在等待，連線恢復後會自動繼續。',
  check: '立即檢查',
  title: '磁碟或資料夾無法使用 — 將自動重試',
  hint: '位置恢復可用後，GenOffice 會自動檢查並重新讀取這些檔案。',
} satisfies Record<keyof typeof zh, string>
