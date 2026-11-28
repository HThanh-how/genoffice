import { copy as zh } from './zh'
export const copy = {
  noReply: 'Model cục bộ không trả lời sau khi thử lại. Vui lòng gửi lại câu hỏi.',
  title: 'Model chat cục bộ',
  missing: 'Chưa tải',
  checking: 'Đang kiểm SHA-256…',
  downloading: 'Đang tải {n}%',
  paused: 'Đã tạm dừng {n}%',
  ready: 'Sẵn sàng',
  error: 'Lỗi',
  download: 'Tải model',
  cancel: 'Hủy',
  resume: 'Tiếp tục',
  remove: 'Xóa model',
  keepHot: 'Giữ nóng (phút)',
  thinking: 'Suy luận (chậm hơn)',
  autoDownload: 'Tự tải model khi cần',
  advanced: 'Nâng cao',
  threads: 'Số luồng CPU',
  gpu: 'Backend',
  context: 'Số token ngữ cảnh',
  limits:
    'Chỉ văn bản, chưa hỗ trợ ảnh. Không khuyến nghị cho coding, hội thoại dài hoặc suy luận phức tạp.',
  license:
    'LFM Open License v1.0: doanh thu trên 10 triệu USD/năm cần thỏa thuận riêng với Liquid AI.',
  gpuWarning:
    'Mặc định CPU. Vulkan đã gây crash trên Radeon 780M khi thử nghiệm; backend GPU cần runtime tương thích được cài riêng.',
  offline: 'Đang ngoại tuyến. Kết nối mạng để tải model cục bộ.',
  metered: 'Mạng tính cước: đã tạm dừng tự tải model. Chọn Tải model để tiếp tục thủ công.',
} satisfies Record<keyof typeof zh, string>
