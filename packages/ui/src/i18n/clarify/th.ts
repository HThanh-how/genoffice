import type zh from './zh'

const strings = {
  aiActionStep: 'ขั้นตอน {step}/{total}: {text} (Esc เพื่อยกเลิก)',
  aiActionApprove: 'อนุญาต',
  aiActionDeny: 'ปฏิเสธ',
  aiActionConfirm: 'อนุญาตการดำเนินการนี้หรือไม่?',
  aiActionIndex: 'เปิดดัชนี',
  aiActionSettings: 'เปิดการตั้งค่า',
  aiActionNewChat: 'เริ่มแชตใหม่',
  aiActionPrint: 'เปิดไฟล์ → พิมพ์',
  aiActionExportPdf: 'ส่งออก PDF',
  aiActionFile: 'เปิดเมนูไฟล์',
  aiActionHandoff: 'ดำเนินการต่อในกล่องโต้ตอบ ผลลัพธ์ขึ้นอยู่กับตัวเลือกของคุณ',
  aiClarifyTitle: 'ขอถามคำถามสั้น ๆ เพื่อให้หน้าเว็บตรงกับความต้องการของคุณยิ่งขึ้น',
  aiClarifyDecide: 'ตัดสินใจให้ฉัน',
  aiClarifyDecideAnswer: '(ตัดสินใจให้ฉัน)',
  aiClarifyMulti: 'เลือกได้หลายข้อ',
  aiClarifyNext: 'ถัดไป',
  aiClarifyPrev: 'ก่อนหน้า',
  aiClarifyOther: 'อื่น ๆ (พิมพ์เอง)',
  aiClarifySelected: 'เลือกแล้ว {n}',
  aiClarifySkip: 'ข้ามแบบสอบถาม',
  aiClarifySubmit: 'ส่ง',
} satisfies Record<keyof typeof zh, string>

export default strings
