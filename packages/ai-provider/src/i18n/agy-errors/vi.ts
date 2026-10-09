import type { zh } from './zh'

export const vi = {
  agyErrQuota:
    'Hạn mức sử dụng Antigravity của bạn đã hết. Hãy đợi hạn mức được đặt lại, hoặc chuyển sang mô hình hay nhà cung cấp khác trong Cài đặt.',
  agyErrQuotaAt:
    'Hạn mức sử dụng Antigravity của bạn đã hết. Thời điểm đặt lại: {time}. Hãy đợi hạn mức được đặt lại, hoặc chuyển sang mô hình hay nhà cung cấp khác trong Cài đặt.',
  agyErrAuth:
    'Antigravity chưa đăng nhập hoặc phiên đã hết hạn. Hãy đăng nhập lại trong Cài đặt → Mô hình AI.',
} satisfies Record<keyof typeof zh, string>
