import type { zh } from './zh'

export const strings = {
  title: 'Cho phép thao tác tệp này?',
  approve: 'Chấp thuận',
  deny: 'Từ chối',
  create_folder: 'Tạo thư mục',
  move_file: 'Di chuyển hoặc đổi tên tệp',
  delete_file: 'Chuyển vào thùng rác hệ thống',
  list_folder: 'Liệt kê thư mục',
  export_pdf: 'Xuất tệp đã lưu sang PDF',
} satisfies Record<keyof typeof zh, string>
