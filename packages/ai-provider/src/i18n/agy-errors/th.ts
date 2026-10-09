import type { zh } from './zh'

export const th = {
  agyErrQuota:
    'โควตาการใช้งาน Antigravity ของคุณหมดแล้ว โปรดรอให้รีเซ็ต หรือเปลี่ยนไปใช้โมเดลหรือผู้ให้บริการอื่นในการตั้งค่า',
  agyErrQuotaAt:
    'โควตาการใช้งาน Antigravity ของคุณหมดแล้ว เวลารีเซ็ต: {time} โปรดรอให้รีเซ็ต หรือเปลี่ยนไปใช้โมเดลหรือผู้ให้บริการอื่นในการตั้งค่า',
  agyErrAuth:
    'ยังไม่ได้ลงชื่อเข้าใช้ Antigravity หรือเซสชันหมดอายุ โปรดลงชื่อเข้าใช้อีกครั้งที่ การตั้งค่า → โมเดล AI',
} satisfies Record<keyof typeof zh, string>
