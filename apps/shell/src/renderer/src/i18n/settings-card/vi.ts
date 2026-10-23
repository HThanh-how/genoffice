import type { zh } from './zh'

export const copy = {
  appearance: 'Giao diện',
  ai: 'Bảng AI',
  files: 'Tệp & lưu',
  legacy: 'Tệp Office cũ',
  legacyHint: 'Chuyển đổi .doc và .ppt',
  privacy: 'Riêng tư & clipboard',
  opening: 'Hiệu ứng mở tệp',
  openingHint: 'Cảnh chạy khi mở một tệp',
  appearanceHint: 'Ngôn ngữ, màu giao diện và cách hiển thị',
  aiHint: 'Điều chỉnh trợ lý theo cách bạn làm việc',
  filesHint: 'Thư mục mặc định và lưu tự động',
  privacyHint: 'Chọn dữ liệu ứng dụng ghi nhớ và chia sẻ',
  modelHint: 'Chọn nhà cung cấp và cấu hình kết nối',
  searchHint: 'Chọn cách trợ lý tìm nguồn thông tin',
  mediaProviderHint: 'Chọn nhà cung cấp và mô hình cho tính năng này',
  aboutTitle: 'Ứng dụng & cập nhật',
  aboutHint: 'Phiên bản, nguồn cập nhật và kênh phát hành',
  studioHint: 'Chọn, xem thử và tùy chỉnh thẻ mở tệp',
  advancedHint: 'Nhập và xem thử cảnh HTML của riêng bạn',
} satisfies Record<keyof typeof zh, string>
