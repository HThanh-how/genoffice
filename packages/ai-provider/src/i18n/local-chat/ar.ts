import { copy as zh } from './zh'
export const copy = {
  title: 'نموذج محادثة محلي',
  missing: 'لم يتم التنزيل',
  checking: 'التحقق من SHA-256…',
  downloading: 'جارٍ التنزيل {n}%',
  paused: 'متوقف مؤقتًا {n}%',
  ready: 'جاهز',
  error: 'خطأ',
  download: 'تنزيل',
  cancel: 'إلغاء',
  resume: 'استئناف',
  remove: 'حذف النموذج',
  keepHot: 'الاحتفاظ في الذاكرة (دقائق)',
  thinking: 'الاستدلال (أبطأ)',
  autoDownload: 'تنزيل النموذج عند الحاجة',
  advanced: 'متقدم',
  threads: 'خيوط CPU',
  gpu: 'المحرك',
  context: 'رموز السياق',
  limits:
    'نص فقط، الصور غير مدعومة بعد. لا يُنصح به للبرمجة أو المحادثات الطويلة أو الاستدلال المعقد.',
  license:
    'LFM Open License v1.0: الإيرادات السنوية فوق 10 ملايين USD تتطلب اتفاقية منفصلة مع Liquid AI.',
  gpuWarning:
    'الافتراضي CPU. تعطل Vulkan على Radeon 780M في الاختبار؛ تتطلب GPU بيئة تشغيل متوافقة مثبتة بشكل منفصل.',
  offline: 'غير متصل. اتصل لتنزيل النموذج المحلي.',
  metered: 'شبكة محدودة: تم إيقاف التنزيل التلقائي. نزّل يدويًا للمتابعة.',
} satisfies Record<keyof typeof zh, string>
