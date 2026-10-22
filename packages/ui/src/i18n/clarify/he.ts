import type zh from './zh'

const strings = {
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
