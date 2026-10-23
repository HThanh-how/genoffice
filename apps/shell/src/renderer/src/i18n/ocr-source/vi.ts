import type { zh } from './zh'

export const vi = {
  waiting:
    '{root} chưa được kết nối (từ {date}). {n} tệp đang chờ và sẽ tự động tiếp tục khi kết nối trở lại.',
  check: 'Kiểm tra ngay',
  title: 'Ổ đĩa hoặc thư mục chưa khả dụng — sẽ tự động thử lại',
  hint: 'GenOffice sẽ tự kiểm tra và đọc lại các tệp này khi vị trí khả dụng trở lại.',
} satisfies Record<keyof typeof zh, string>
