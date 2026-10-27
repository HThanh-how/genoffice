import type zh from './zh'

const strings = {
  aiActionStep: 'Adım {step}/{total}: {text} (İptal için Esc)',
  aiActionApprove: 'Onayla',
  aiActionDeny: 'Reddet',
  aiActionConfirm: 'Bu işleme izin verilsin mi?',
  aiActionIndex: 'Dizini aç',
  aiActionSettings: 'Ayarları aç',
  aiActionNewChat: 'Yeni sohbet başlat',
  aiActionPrint: 'Dosya → Yazdır’ı aç',
  aiActionExportPdf: 'PDF olarak dışa aktar',
  aiActionFile: 'Dosya menüsünü aç',
  aiActionHandoff: 'İletişim kutusunda devam edin; sonuç seçiminize bağlıdır.',
  aiClarifyTitle: 'Sayfayı size göre uyarlamak için birkaç kısa soru',
  aiClarifyDecide: 'Benim yerime karar ver',
  aiClarifyDecideAnswer: '(benim yerime karar ver)',
  aiClarifyMulti: 'Çoktan seçmeli',
  aiClarifyNext: 'Sonraki',
  aiClarifyPrev: 'Önceki',
  aiClarifyOther: 'Diğer (yazın)',
  aiClarifySelected: '{n} seçildi',
  aiClarifySkip: 'Anketi atla',
  aiClarifySubmit: 'Gönder',
} satisfies Record<keyof typeof zh, string>

export default strings
