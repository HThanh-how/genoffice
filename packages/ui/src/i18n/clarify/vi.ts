import type zh from './zh'

const strings = {
  aiActionStep: 'Bước {step}/{total}: {text} (Esc để hủy)',
  aiActionApprove: 'Cho phép',
  aiActionDeny: 'Từ chối',
  aiActionConfirm: 'Cho phép thao tác này?',
  aiActionIndex: 'Mở Chỉ mục',
  aiActionSettings: 'Mở Cài đặt',
  aiActionNewChat: 'Bắt đầu trò chuyện mới',
  aiActionPrint: 'Mở Tệp → In',
  aiActionExportPdf: 'Xuất PDF',
  aiActionFile: 'Mở trình đơn Tệp',
  aiActionHandoff: 'Tiếp tục trong hộp thoại; kết quả tùy thuộc lựa chọn của bạn.',
  aiClarifyTitle: 'Một vài câu hỏi nhanh để điều chỉnh trang phù hợp với bạn',
  aiClarifyDecide: 'Quyết định giúp tôi',
  aiClarifyDecideAnswer: '(quyết định giúp tôi)',
  aiClarifyMulti: 'Nhiều lựa chọn',
  aiClarifyNext: 'Tiếp theo',
  aiClarifyPrev: 'Quay lại',
  aiClarifyOther: 'Khác (nhập vào)',
  aiClarifySelected: 'Đã chọn {n}',
  aiClarifySkip: 'Bỏ qua khảo sát',
  aiClarifySubmit: 'Gửi',
} satisfies Record<keyof typeof zh, string>

export default strings
