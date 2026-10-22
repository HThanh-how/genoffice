import type zh from './zh'

const strings = {
  aiActionStep: 'الخطوة {step}/{total}: {text} (Esc للإلغاء)',
  aiActionApprove: 'سماح',
  aiActionDeny: 'رفض',
  aiActionConfirm: 'السماح بهذا الإجراء؟',
  aiActionIndex: 'فتح الفهرس',
  aiActionSettings: 'فتح الإعدادات',
  aiActionNewChat: 'بدء محادثة جديدة',
  aiActionPrint: 'فتح ملف ← طباعة',
  aiActionExportPdf: 'تصدير PDF',
  aiActionFile: 'فتح قائمة ملف',
  aiActionHandoff: 'تابع في مربع الحوار؛ تعتمد النتيجة على اختيارك.',
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
