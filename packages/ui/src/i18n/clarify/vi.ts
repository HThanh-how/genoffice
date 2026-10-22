import type zh from './zh'

const strings = {
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
