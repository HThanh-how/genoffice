import type { zh } from './zh'

export const strings = {
  title: 'هل تسمح بإجراء الملف هذا؟',
  approve: 'موافقة',
  deny: 'رفض',
  create_folder: 'إنشاء مجلد',
  move_file: 'نقل الملف أو إعادة تسميته',
  delete_file: 'نقل إلى سلة محذوفات النظام',
  list_folder: 'عرض المجلد',
  merge_documents: 'دمج المستندات في ملف جديد',
  export_pdf: 'تصدير الملف المحفوظ إلى PDF',
} satisfies Record<keyof typeof zh, string>
