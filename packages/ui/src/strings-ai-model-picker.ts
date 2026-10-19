import type { Lang } from '@genoffice/i18n'

export interface AiModelPickerStrings {
  /** chip tooltip / list heading */
  title: string
  /** chip text while no provider is usable yet */
  choose: string
  /** last row: jump to Settings › AI Model */
  manage: string
  /** an Antigravity model that is saved but cannot be used right now */
  unavailable: string
}

export const AI_MODEL_PICKER_STRINGS: Record<Lang, AiModelPickerStrings> = {
  zh: { title: '模型', choose: '选择模型', manage: '管理模型…', unavailable: '不可用' },
  en: {
    title: 'Model',
    choose: 'Choose model',
    manage: 'Manage models…',
    unavailable: 'not available',
  },
  ja: {
    title: 'モデル',
    choose: 'モデルを選択',
    manage: 'モデルを管理…',
    unavailable: '使用できない',
  },
  ko: { title: '모델', choose: '모델 선택', manage: '모델 관리…', unavailable: '사용할 수 없음' },
  fr: {
    title: 'Modèle',
    choose: 'Choisir un modèle',
    manage: 'Gérer les modèles…',
    unavailable: 'non disponible',
  },
  de: {
    title: 'Modell',
    choose: 'Modell wählen',
    manage: 'Modelle verwalten…',
    unavailable: 'nicht verfügbar',
  },
  es: {
    title: 'Modelo',
    choose: 'Elegir modelo',
    manage: 'Gestionar modelos…',
    unavailable: 'no disponible',
  },
  th: {
    title: 'โมเดล',
    choose: 'เลือกโมเดล',
    manage: 'จัดการโมเดล…',
    unavailable: 'ไม่พร้อมใช้งาน',
  },
  id: {
    title: 'Model',
    choose: 'Pilih model',
    manage: 'Kelola model…',
    unavailable: 'tidak tersedia',
  },
  ru: {
    title: 'Модель',
    choose: 'Выбрать модель',
    manage: 'Управление моделями…',
    unavailable: 'недоступна',
  },
  ar: {
    title: 'النموذج',
    choose: 'اختيار النموذج',
    manage: 'إدارة النماذج…',
    unavailable: 'غير متاح',
  },
  pt: {
    title: 'Modelo',
    choose: 'Escolher modelo',
    manage: 'Gerenciar modelos…',
    unavailable: 'indisponível',
  },
  it: {
    title: 'Modello',
    choose: 'Scegli modello',
    manage: 'Gestisci modelli…',
    unavailable: 'non disponibile',
  },
  pl: {
    title: 'Model',
    choose: 'Wybierz model',
    manage: 'Zarządzaj modelami…',
    unavailable: 'niedostępny',
  },
  cs: {
    title: 'Model',
    choose: 'Vybrat model',
    manage: 'Spravovat modely…',
    unavailable: 'není dostupný',
  },
  nl: {
    title: 'Model',
    choose: 'Model kiezen',
    manage: 'Modellen beheren…',
    unavailable: 'niet beschikbaar',
  },
  ms: {
    title: 'Model',
    choose: 'Pilih model',
    manage: 'Urus model…',
    unavailable: 'tidak tersedia',
  },
  he: { title: 'מודל', choose: 'בחירת מודל', manage: 'ניהול מודלים…', unavailable: 'לא זמין' },
  hi: {
    title: 'मॉडल',
    choose: 'मॉडल चुनें',
    manage: 'मॉडल प्रबंधित करें…',
    unavailable: 'उपलब्ध नहीं',
  },
  'zh-TW': { title: '模型', choose: '選擇模型', manage: '管理模型…', unavailable: '無法使用' },
  vi: {
    title: 'Mô hình',
    choose: 'Chọn mô hình',
    manage: 'Quản lý mô hình…',
    unavailable: 'không khả dụng',
  },
}
