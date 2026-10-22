import type { zh } from './zh'

export const strings = {
  title: 'อนุญาตการดำเนินการไฟล์นี้หรือไม่',
  approve: 'อนุมัติ',
  deny: 'ปฏิเสธ',
  create_folder: 'สร้างโฟลเดอร์',
  move_file: 'ย้ายหรือเปลี่ยนชื่อไฟล์',
  delete_file: 'ย้ายไปถังขยะของระบบ',
  list_folder: 'แสดงรายการโฟลเดอร์',
  merge_documents: 'รวมเอกสารเป็นไฟล์ใหม่',
  export_pdf: 'ส่งออกไฟล์ที่บันทึกแล้วเป็น PDF',
} satisfies Record<keyof typeof zh, string>
