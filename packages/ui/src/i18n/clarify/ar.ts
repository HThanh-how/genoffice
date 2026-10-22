import type zh from './zh'

const strings = {
  aiClarifyTitle: 'بضعة أسئلة سريعة لتكون الصفحة أنسب لاحتياجاتك',
  aiClarifyDecide: 'قرِّر بالنيابة عني',
  aiClarifyDecideAnswer: '(قرِّر بالنيابة عني)',
  aiClarifyMulti: 'اختيار متعدد',
  aiClarifyNext: 'التالي',
  aiClarifyPrev: 'السابق',
  aiClarifyOther: 'أخرى (يمكن الكتابة)',
  aiClarifySelected: 'تم تحديد {n}',
  aiClarifySkip: 'تخطي الاستبيان',
  aiClarifySubmit: 'إرسال',
} satisfies Record<keyof typeof zh, string>

export default strings
