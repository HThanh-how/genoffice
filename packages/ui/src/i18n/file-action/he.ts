import type { zh } from './zh'

export const strings = {
  title: 'לאפשר פעולה זו בקובץ?',
  approve: 'אישור',
  deny: 'דחייה',
  create_folder: 'יצירת תיקייה',
  move_file: 'העברה או שינוי שם קובץ',
  delete_file: 'העברה לסל המיחזור של המערכת',
  list_folder: 'הצגת תיקייה',
  merge_documents: 'מיזוג מסמכים לקובץ חדש',
  export_pdf: 'ייצוא הקובץ השמור ל־PDF',
} satisfies Record<keyof typeof zh, string>
