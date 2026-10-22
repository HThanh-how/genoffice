import type zh from './zh'

const strings = {
  aiActionStep: 'שלב {step}/{total}: {text} (Esc לביטול)',
  aiActionApprove: 'אישור',
  aiActionDeny: 'דחייה',
  aiActionConfirm: 'לאפשר פעולה זו?',
  aiActionIndex: 'פתיחת האינדקס',
  aiActionSettings: 'פתיחת הגדרות',
  aiActionNewChat: 'התחלת שיחה חדשה',
  aiActionPrint: 'פתיחת קובץ ← הדפסה',
  aiActionExportPdf: 'ייצוא ל־PDF',
  aiActionFile: 'פתיחת תפריט קובץ',
  aiActionHandoff: 'יש להמשיך בחלון הדו־שיח; התוצאה תלויה בבחירה שלך.',
  aiClarifyTitle: 'כמה שאלות קצרות כדי להתאים את העמוד אליך',
  aiClarifyDecide: 'החלט בשבילי',
  aiClarifyDecideAnswer: '(החלט בשבילי)',
  aiClarifyMulti: 'בחירה מרובה',
  aiClarifyNext: 'הבא',
  aiClarifyPrev: 'הקודם',
  aiClarifyOther: 'אחר (הקלד)',
  aiClarifySelected: 'נבחרו {n}',
  aiClarifySkip: 'דלג על השאלון',
  aiClarifySubmit: 'שלח',
} satisfies Record<keyof typeof zh, string>

export default strings
