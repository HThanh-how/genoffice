import { useEffect, useRef, useState } from 'react'
import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'
import { useI18n } from './locale'
import { IndexingModeSettings } from './fork/IndexingModeSettings'

type MemoryStatus = Awaited<ReturnType<typeof window.aiOffice.getDocumentMemoryStatus>>
type FolderScanStatus = {
  state?: 'running' | 'complete' | 'stopped'
  running: boolean
  root?: string
  discovered: number
  enrolled: number
  skipped: number
  errors: number
  lastError?: string
}

const fallbackFolderScanStrings = {
  title: 'Scan a folder',
  choose: 'Choose folder and scan',
  running: 'Scanning {folder}',
  progress: 'Found {count} files so far',
  complete: 'Found {count} files in this folder',
  stopped: 'Scan stopped after finding {count} files',
  counts: 'Added {enrolled} · skipped {skipped} · errors {errors}',
  embedding: '{count} files are waiting for local processing',
  stop: 'Stop scan',
}
const folderScanStrings: Record<Lang, typeof fallbackFolderScanStrings> = {
  zh: fallbackFolderScanStrings,
  en: fallbackFolderScanStrings,
  ja: fallbackFolderScanStrings,
  ko: fallbackFolderScanStrings,
  fr: fallbackFolderScanStrings,
  de: fallbackFolderScanStrings,
  es: fallbackFolderScanStrings,
  th: fallbackFolderScanStrings,
  id: fallbackFolderScanStrings,
  ru: fallbackFolderScanStrings,
  ar: fallbackFolderScanStrings,
  pt: fallbackFolderScanStrings,
  it: fallbackFolderScanStrings,
  pl: fallbackFolderScanStrings,
  cs: fallbackFolderScanStrings,
  nl: fallbackFolderScanStrings,
  ms: fallbackFolderScanStrings,
  he: fallbackFolderScanStrings,
  hi: fallbackFolderScanStrings,
  'zh-TW': fallbackFolderScanStrings,
  vi: {
    title: 'Quét thư mục',
    choose: 'Chọn thư mục để quét',
    running: 'Đang quét {folder}',
    progress: 'Đã tìm thấy {count} tệp',
    complete: 'Đã tìm thấy {count} tệp trong thư mục này',
    stopped: 'Đã dừng quét sau khi tìm thấy {count} tệp',
    counts: 'Đã thêm {enrolled} · bỏ qua {skipped} · lỗi {errors}',
    embedding: 'Còn {count} tệp đang chờ xử lý nội dung',
    stop: 'Dừng quét',
  },
}
type FolderScanStringKey = keyof typeof fallbackFolderScanStrings

const memoryDictionary = defineStrings({
  zh: {
    title: '文档记忆',
    description: '在本机建立文档内容索引，供 AI 回答问题时查找相关来源。内容保留在此设备。',
    enabled: '启用文档记忆',
    model: '本地嵌入模型',
    downloading: '正在下载模型 {progress}%',
    starting: '正在准备模型…',
    ready: '已就绪',
    modelError: '模型下载失败',
    docs: '文档',
    chunks: '文本片段',
    vectors: '向量',
    pending: '等待处理',
    errors: '错误',
    location: '索引位置',
    recent: '最近记忆的文档',
    empty: '尚未索引文档',
    exclude: '排除',
    clear: '清除索引',
    confirmClear: '清除全部索引？文档记忆将删除本机保存的索引数据。',
    confirm: '清除',
    cancel: '取消',
    error: '操作失败',
  },
  en: {
    title: 'Document memory',
    description:
      'Build a local index of document contents so AI can find relevant sources when answering. Content stays on this device.',
    enabled: 'Enable document memory',
    model: 'Local embedding model',
    downloading: 'Downloading model {progress}%',
    starting: 'Preparing model…',
    ready: 'Ready',
    modelError: 'Model download failed',
    docs: 'Documents',
    chunks: 'Text chunks',
    vectors: 'Vectors',
    pending: 'Pending',
    errors: 'Errors',
    location: 'Index location',
    recent: 'Recently remembered documents',
    empty: 'No documents indexed yet',
    exclude: 'Exclude',
    clear: 'Clear index',
    confirmClear: 'Clear the entire index? This deletes the locally stored index data.',
    confirm: 'Clear',
    cancel: 'Cancel',
    error: 'Action failed',
  },
  ja: {
    title: 'ドキュメントメモリ',
    description: '回答時に関連資料を探せるよう、文書内容の索引をこの端末に作成します。',
    enabled: 'ドキュメントメモリを有効にする',
    model: 'ローカル埋め込みモデル',
    downloading: 'モデルをダウンロード中 {progress}%',
    starting: 'モデルを準備中…',
    ready: '準備完了',
    modelError: 'モデルのダウンロードに失敗',
    docs: '文書',
    chunks: 'テキスト片',
    vectors: 'ベクトル',
    pending: '処理待ち',
    errors: 'エラー',
    location: '索引の場所',
    recent: '最近記憶した文書',
    empty: '索引済み文書はありません',
    exclude: '除外',
    clear: '索引を消去',
    confirmClear: '索引全体を消去しますか？端末内の索引データを削除します。',
    confirm: '消去',
    cancel: 'キャンセル',
    error: '操作に失敗しました',
  },
  ko: {
    title: '문서 기억',
    description: '답변에 필요한 문서를 찾도록 이 기기에 문서 내용의 로컬 색인을 만듭니다.',
    enabled: '문서 기억 사용',
    model: '로컬 임베딩 모델',
    downloading: '모델 다운로드 중 {progress}%',
    starting: '모델 준비 중…',
    ready: '준비됨',
    modelError: '모델 다운로드 실패',
    docs: '문서',
    chunks: '텍스트 조각',
    vectors: '벡터',
    pending: '대기 중',
    errors: '오류',
    location: '색인 위치',
    recent: '최근 기억한 문서',
    empty: '색인된 문서가 없습니다',
    exclude: '제외',
    clear: '색인 지우기',
    confirmClear: '전체 색인을 지울까요? 이 기기에 저장된 색인 데이터가 삭제됩니다.',
    confirm: '지우기',
    cancel: '취소',
    error: '작업 실패',
  },
  fr: {
    title: 'Mémoire documentaire',
    description:
      'Crée un index local du contenu des documents pour trouver des sources pertinentes. Le contenu reste sur cet appareil.',
    enabled: 'Activer la mémoire documentaire',
    model: 'Modèle local',
    downloading: 'Téléchargement du modèle {progress} %',
    starting: 'Préparation du modèle…',
    ready: 'Prêt',
    modelError: 'Échec du téléchargement',
    docs: 'Documents',
    chunks: 'Extraits',
    vectors: 'Vecteurs',
    pending: 'En attente',
    errors: 'Erreurs',
    location: 'Emplacement de l’index',
    recent: 'Documents mémorisés récemment',
    empty: 'Aucun document indexé',
    exclude: 'Exclure',
    clear: 'Effacer l’index',
    confirmClear: 'Effacer tout l’index ? Les données locales seront supprimées.',
    confirm: 'Effacer',
    cancel: 'Annuler',
    error: 'Échec de l’action',
  },
  de: {
    title: 'Dokumentgedächtnis',
    description:
      'Erstellt einen lokalen Inhaltsindex, damit die KI passende Quellen findet. Inhalte bleiben auf diesem Gerät.',
    enabled: 'Dokumentgedächtnis aktivieren',
    model: 'Lokales Einbettungsmodell',
    downloading: 'Modell wird geladen: {progress} %',
    starting: 'Modell wird vorbereitet…',
    ready: 'Bereit',
    modelError: 'Modelldownload fehlgeschlagen',
    docs: 'Dokumente',
    chunks: 'Textabschnitte',
    vectors: 'Vektoren',
    pending: 'Ausstehend',
    errors: 'Fehler',
    location: 'Indexspeicherort',
    recent: 'Zuletzt gespeicherte Dokumente',
    empty: 'Noch keine Dokumente indexiert',
    exclude: 'Ausschließen',
    clear: 'Index löschen',
    confirmClear: 'Gesamten Index löschen? Die lokal gespeicherten Indexdaten werden entfernt.',
    confirm: 'Löschen',
    cancel: 'Abbrechen',
    error: 'Aktion fehlgeschlagen',
  },
  es: {
    title: 'Memoria de documentos',
    description:
      'Crea un índice local del contenido para encontrar fuentes relevantes. El contenido permanece en este dispositivo.',
    enabled: 'Activar memoria de documentos',
    model: 'Modelo local',
    downloading: 'Descargando modelo {progress} %',
    starting: 'Preparando modelo…',
    ready: 'Listo',
    modelError: 'Error al descargar el modelo',
    docs: 'Documentos',
    chunks: 'Fragmentos',
    vectors: 'Vectores',
    pending: 'Pendientes',
    errors: 'Errores',
    location: 'Ubicación del índice',
    recent: 'Documentos recordados recientemente',
    empty: 'Aún no hay documentos indexados',
    exclude: 'Excluir',
    clear: 'Borrar índice',
    confirmClear: '¿Borrar todo el índice? Se eliminarán los datos guardados localmente.',
    confirm: 'Borrar',
    cancel: 'Cancelar',
    error: 'La acción falló',
  },
  th: {
    title: 'ความจำเอกสาร',
    description:
      'สร้างดัชนีเนื้อหาเอกสารในเครื่อง เพื่อค้นหาแหล่งข้อมูลที่เกี่ยวข้อง โดยข้อมูลยังอยู่ในอุปกรณ์นี้',
    enabled: 'เปิดใช้ความจำเอกสาร',
    model: 'โมเดลเวกเตอร์ในเครื่อง',
    downloading: 'กำลังดาวน์โหลดโมเดล {progress}%',
    starting: 'กำลังเตรียมโมเดล…',
    ready: 'พร้อม',
    modelError: 'ดาวน์โหลดโมเดลไม่สำเร็จ',
    docs: 'เอกสาร',
    chunks: 'ส่วนข้อความ',
    vectors: 'เวกเตอร์',
    pending: 'รอดำเนินการ',
    errors: 'ข้อผิดพลาด',
    location: 'ตำแหน่งดัชนี',
    recent: 'เอกสารที่จำล่าสุด',
    empty: 'ยังไม่มีเอกสารในดัชนี',
    exclude: 'ยกเว้น',
    clear: 'ล้างดัชนี',
    confirmClear: 'ล้างดัชนีทั้งหมดหรือไม่ ข้อมูลดัชนีในเครื่องจะถูกลบ',
    confirm: 'ล้าง',
    cancel: 'ยกเลิก',
    error: 'ดำเนินการไม่สำเร็จ',
  },
  id: {
    title: 'Memori dokumen',
    description:
      'Buat indeks isi dokumen di perangkat ini agar AI dapat menemukan sumber yang relevan.',
    enabled: 'Aktifkan memori dokumen',
    model: 'Model embedding lokal',
    downloading: 'Mengunduh model {progress}%',
    starting: 'Menyiapkan model…',
    ready: 'Siap',
    modelError: 'Unduhan model gagal',
    docs: 'Dokumen',
    chunks: 'Potongan teks',
    vectors: 'Vektor',
    pending: 'Menunggu',
    errors: 'Kesalahan',
    location: 'Lokasi indeks',
    recent: 'Dokumen yang baru diingat',
    empty: 'Belum ada dokumen terindeks',
    exclude: 'Kecualikan',
    clear: 'Hapus indeks',
    confirmClear: 'Hapus seluruh indeks? Data indeks lokal akan dihapus.',
    confirm: 'Hapus',
    cancel: 'Batal',
    error: 'Tindakan gagal',
  },
  ru: {
    title: 'Память документов',
    description:
      'Создаёт локальный индекс содержимого, чтобы находить нужные источники. Данные остаются на устройстве.',
    enabled: 'Включить память документов',
    model: 'Локальная модель эмбеддингов',
    downloading: 'Загрузка модели: {progress}%',
    starting: 'Подготовка модели…',
    ready: 'Готово',
    modelError: 'Не удалось загрузить модель',
    docs: 'Документы',
    chunks: 'Фрагменты текста',
    vectors: 'Векторы',
    pending: 'В очереди',
    errors: 'Ошибки',
    location: 'Расположение индекса',
    recent: 'Недавно запомненные документы',
    empty: 'Индекс пуст',
    exclude: 'Исключить',
    clear: 'Очистить индекс',
    confirmClear: 'Очистить весь индекс? Локальные данные индекса будут удалены.',
    confirm: 'Очистить',
    cancel: 'Отмена',
    error: 'Не удалось выполнить действие',
  },
  ar: {
    title: 'ذاكرة المستندات',
    description:
      'ينشئ فهرسًا محليًا لمحتوى المستندات للعثور على المصادر المناسبة. يبقى المحتوى على هذا الجهاز.',
    enabled: 'تفعيل ذاكرة المستندات',
    model: 'نموذج تضمين محلي',
    downloading: 'جارٍ تنزيل النموذج {progress}٪',
    starting: 'جارٍ تجهيز النموذج…',
    ready: 'جاهز',
    modelError: 'فشل تنزيل النموذج',
    docs: 'المستندات',
    chunks: 'مقاطع نصية',
    vectors: 'المتجهات',
    pending: 'قيد الانتظار',
    errors: 'الأخطاء',
    location: 'موقع الفهرس',
    recent: 'المستندات المحفوظة مؤخرًا',
    empty: 'لا توجد مستندات مفهرسة',
    exclude: 'استبعاد',
    clear: 'مسح الفهرس',
    confirmClear: 'هل تريد مسح الفهرس بالكامل؟ سيتم حذف بيانات الفهرس المحلية.',
    confirm: 'مسح',
    cancel: 'إلغاء',
    error: 'فشل الإجراء',
  },
  pt: {
    title: 'Memória de documentos',
    description:
      'Cria um índice local do conteúdo para encontrar fontes relevantes. O conteúdo fica neste dispositivo.',
    enabled: 'Ativar memória de documentos',
    model: 'Modelo local de embeddings',
    downloading: 'Baixando modelo {progress}%',
    starting: 'Preparando modelo…',
    ready: 'Pronto',
    modelError: 'Falha ao baixar o modelo',
    docs: 'Documentos',
    chunks: 'Trechos de texto',
    vectors: 'Vetores',
    pending: 'Pendentes',
    errors: 'Erros',
    location: 'Local do índice',
    recent: 'Documentos lembrados recentemente',
    empty: 'Nenhum documento indexado',
    exclude: 'Excluir',
    clear: 'Limpar índice',
    confirmClear: 'Limpar todo o índice? Os dados locais serão excluídos.',
    confirm: 'Limpar',
    cancel: 'Cancelar',
    error: 'Ação falhou',
  },
  it: {
    title: 'Memoria documenti',
    description:
      'Crea un indice locale dei contenuti per trovare fonti pertinenti. I contenuti restano su questo dispositivo.',
    enabled: 'Attiva memoria documenti',
    model: 'Modello locale',
    downloading: 'Download modello {progress}%',
    starting: 'Preparazione modello…',
    ready: 'Pronto',
    modelError: 'Download del modello non riuscito',
    docs: 'Documenti',
    chunks: 'Frammenti di testo',
    vectors: 'Vettori',
    pending: 'In attesa',
    errors: 'Errori',
    location: 'Percorso indice',
    recent: 'Documenti ricordati di recente',
    empty: 'Nessun documento indicizzato',
    exclude: 'Escludi',
    clear: 'Cancella indice',
    confirmClear: 'Cancellare tutto l’indice? I dati locali verranno eliminati.',
    confirm: 'Cancella',
    cancel: 'Annulla',
    error: 'Operazione non riuscita',
  },
  pl: {
    title: 'Pamięć dokumentów',
    description:
      'Tworzy lokalny indeks treści, aby znaleźć odpowiednie źródła. Treść pozostaje na tym urządzeniu.',
    enabled: 'Włącz pamięć dokumentów',
    model: 'Lokalny model',
    downloading: 'Pobieranie modelu {progress}%',
    starting: 'Przygotowywanie modelu…',
    ready: 'Gotowy',
    modelError: 'Pobieranie modelu nie powiodło się',
    docs: 'Dokumenty',
    chunks: 'Fragmenty tekstu',
    vectors: 'Wektory',
    pending: 'Oczekujące',
    errors: 'Błędy',
    location: 'Lokalizacja indeksu',
    recent: 'Ostatnio zapamiętane dokumenty',
    empty: 'Brak dokumentów w indeksie',
    exclude: 'Wyklucz',
    clear: 'Wyczyść indeks',
    confirmClear: 'Wyczyścić cały indeks? Lokalne dane indeksu zostaną usunięte.',
    confirm: 'Wyczyść',
    cancel: 'Anuluj',
    error: 'Operacja nie powiodła się',
  },
  cs: {
    title: 'Paměť dokumentů',
    description:
      'Vytvoří místní index obsahu pro hledání relevantních zdrojů. Obsah zůstává v tomto zařízení.',
    enabled: 'Zapnout paměť dokumentů',
    model: 'Místní model',
    downloading: 'Stahování modelu {progress} %',
    starting: 'Příprava modelu…',
    ready: 'Připraveno',
    modelError: 'Stažení modelu selhalo',
    docs: 'Dokumenty',
    chunks: 'Textové úryvky',
    vectors: 'Vektory',
    pending: 'Čeká',
    errors: 'Chyby',
    location: 'Umístění indexu',
    recent: 'Nedávno zapamatované dokumenty',
    empty: 'Zatím žádné indexované dokumenty',
    exclude: 'Vyloučit',
    clear: 'Vymazat index',
    confirmClear: 'Vymazat celý index? Místní data indexu budou odstraněna.',
    confirm: 'Vymazat',
    cancel: 'Zrušit',
    error: 'Akce selhala',
  },
  nl: {
    title: 'Documentgeheugen',
    description:
      'Maakt lokaal een inhoudsindex om relevante bronnen te vinden. Inhoud blijft op dit apparaat.',
    enabled: 'Documentgeheugen inschakelen',
    model: 'Lokaal model',
    downloading: 'Model downloaden: {progress}%',
    starting: 'Model voorbereiden…',
    ready: 'Gereed',
    modelError: 'Download van model mislukt',
    docs: 'Documenten',
    chunks: 'Tekstfragmenten',
    vectors: 'Vectoren',
    pending: 'In behandeling',
    errors: 'Fouten',
    location: 'Indexlocatie',
    recent: 'Recent onthouden documenten',
    empty: 'Nog geen documenten geïndexeerd',
    exclude: 'Uitsluiten',
    clear: 'Index wissen',
    confirmClear: 'De volledige index wissen? Lokale indexgegevens worden verwijderd.',
    confirm: 'Wissen',
    cancel: 'Annuleren',
    error: 'Actie mislukt',
  },
  ms: {
    title: 'Memori dokumen',
    description:
      'Bina indeks kandungan dokumen secara setempat untuk mencari sumber berkaitan. Kandungan kekal pada peranti ini.',
    enabled: 'Dayakan memori dokumen',
    model: 'Model embedding setempat',
    downloading: 'Memuat turun model {progress}%',
    starting: 'Menyediakan model…',
    ready: 'Sedia',
    modelError: 'Muat turun model gagal',
    docs: 'Dokumen',
    chunks: 'Petikan teks',
    vectors: 'Vektor',
    pending: 'Menunggu',
    errors: 'Ralat',
    location: 'Lokasi indeks',
    recent: 'Dokumen yang baru diingati',
    empty: 'Tiada dokumen diindeks',
    exclude: 'Kecualikan',
    clear: 'Kosongkan indeks',
    confirmClear: 'Kosongkan seluruh indeks? Data indeks setempat akan dipadam.',
    confirm: 'Kosongkan',
    cancel: 'Batal',
    error: 'Tindakan gagal',
  },
  he: {
    title: 'זיכרון מסמכים',
    description: 'יוצר אינדקס מקומי של תוכן המסמכים כדי למצוא מקורות רלוונטיים. התוכן נשאר במכשיר.',
    enabled: 'הפעלת זיכרון מסמכים',
    model: 'מודל הטמעה מקומי',
    downloading: 'מוריד מודל {progress}%',
    starting: 'מכין מודל…',
    ready: 'מוכן',
    modelError: 'הורדת המודל נכשלה',
    docs: 'מסמכים',
    chunks: 'קטעי טקסט',
    vectors: 'וקטורים',
    pending: 'ממתינים',
    errors: 'שגיאות',
    location: 'מיקום האינדקס',
    recent: 'מסמכים שנזכרו לאחרונה',
    empty: 'אין מסמכים באינדקס',
    exclude: 'החרגה',
    clear: 'ניקוי האינדקס',
    confirmClear: 'לנקות את כל האינדקס? נתוני האינדקס המקומיים יימחקו.',
    confirm: 'ניקוי',
    cancel: 'ביטול',
    error: 'הפעולה נכשלה',
  },
  hi: {
    title: 'दस्तावेज़ स्मृति',
    description:
      'संबंधित स्रोत खोजने के लिए दस्तावेज़ सामग्री का स्थानीय सूचकांक बनाता है। सामग्री इसी डिवाइस पर रहती है।',
    enabled: 'दस्तावेज़ स्मृति चालू करें',
    model: 'स्थानीय एम्बेडिंग मॉडल',
    downloading: 'मॉडल डाउनलोड हो रहा है {progress}%',
    starting: 'मॉडल तैयार हो रहा है…',
    ready: 'तैयार',
    modelError: 'मॉडल डाउनलोड विफल',
    docs: 'दस्तावेज़',
    chunks: 'पाठ अंश',
    vectors: 'वेक्टर',
    pending: 'लंबित',
    errors: 'त्रुटियाँ',
    location: 'सूचकांक स्थान',
    recent: 'हाल ही में याद किए गए दस्तावेज़',
    empty: 'अभी कोई दस्तावेज़ अनुक्रमित नहीं',
    exclude: 'हटाएँ',
    clear: 'सूचकांक साफ़ करें',
    confirmClear: 'पूरा सूचकांक साफ़ करें? स्थानीय सूचकांक डेटा मिटा दिया जाएगा।',
    confirm: 'साफ़ करें',
    cancel: 'रद्द करें',
    error: 'कार्रवाई विफल',
  },
  'zh-TW': {
    title: '文件記憶',
    description: '在本機建立文件內容索引，讓 AI 回答時尋找相關來源。內容保留在此裝置。',
    enabled: '啟用文件記憶',
    model: '本機嵌入模型',
    downloading: '正在下載模型 {progress}%',
    starting: '正在準備模型…',
    ready: '已就緒',
    modelError: '模型下載失敗',
    docs: '文件',
    chunks: '文字片段',
    vectors: '向量',
    pending: '等待處理',
    errors: '錯誤',
    location: '索引位置',
    recent: '最近記憶的文件',
    empty: '尚未索引文件',
    exclude: '排除',
    clear: '清除索引',
    confirmClear: '清除全部索引？本機索引資料將會刪除。',
    confirm: '清除',
    cancel: '取消',
    error: '操作失敗',
  },
  vi: {
    title: 'Bộ nhớ tài liệu',
    description:
      'Tạo chỉ mục nội dung tài liệu trên máy để AI tìm nguồn liên quan khi trả lời. Nội dung vẫn ở thiết bị này.',
    enabled: 'Bật bộ nhớ tài liệu',
    model: 'Mô hình embedding cục bộ',
    downloading: 'Đang tải mô hình {progress}%',
    starting: 'Đang chuẩn bị mô hình…',
    ready: 'Sẵn sàng',
    modelError: 'Tải mô hình thất bại',
    docs: 'Tài liệu',
    chunks: 'Đoạn văn bản',
    vectors: 'Vector',
    pending: 'Đang chờ',
    errors: 'Lỗi',
    location: 'Vị trí chỉ mục',
    recent: 'Tài liệu được ghi nhớ gần đây',
    empty: 'Chưa có tài liệu được lập chỉ mục',
    exclude: 'Loại trừ',
    clear: 'Xóa chỉ mục',
    confirmClear: 'Xóa toàn bộ chỉ mục? Dữ liệu chỉ mục trên máy sẽ bị xóa.',
    confirm: 'Xóa',
    cancel: 'Hủy',
    error: 'Thao tác thất bại',
  },
})
const strings = createI18n(memoryDictionary)

export function DocumentMemorySettings() {
  const { lang } = useI18n()
  const t = (key: keyof typeof memoryDictionary.zh, params?: Record<string, string | number>) =>
    strings(lang as Lang, key, params)
  const scanT = (key: FolderScanStringKey, params?: Record<string, string | number>) => {
    const source = folderScanStrings[lang][key]
    return source.replace(/\{(\w+)\}/g, (match, name: string) =>
      params?.[name] == null ? match : String(params[name]),
    )
  }
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [folderScan, setFolderScan] = useState<FolderScanStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanBusy, setScanBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [actionError, setActionError] = useState('')
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    if (typeof window.aiOffice?.getDocumentMemoryStatus !== 'function')
      return () => {
        mountedRef.current = false
      }
    let active = true
    const refresh = async () => {
      const [memoryResult, scanResult] = await Promise.allSettled([
        window.aiOffice.getDocumentMemoryStatus(),
        typeof window.aiOffice.getDocumentFolderScanStatus === 'function'
          ? window.aiOffice.getDocumentFolderScanStatus()
          : Promise.resolve(null),
      ])
      if (!active) return
      if (memoryResult.status === 'fulfilled') setStatus(memoryResult.value)
      if (scanResult.status === 'fulfilled') setFolderScan(scanResult.value)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      mountedRef.current = false
      window.clearInterval(timer)
    }
  }, [])

  const perform = async (action: () => Promise<MemoryStatus | void>) => {
    setBusy(true)
    setActionError('')
    try {
      const result = await action()
      if (result) setStatus(result)
    } catch {
      setActionError(t('error'))
    } finally {
      setBusy(false)
    }
  }

  const scanFolder = async () => {
    setScanBusy(true)
    setActionError('')
    try {
      const next = await window.aiOffice.scanDocumentFolder()
      if (mountedRef.current && next) setFolderScan(next)
    } catch {
      if (mountedRef.current) setActionError(t('error'))
    } finally {
      if (mountedRef.current) setScanBusy(false)
    }
  }

  const stopFolderScan = async () => {
    setScanBusy(true)
    setActionError('')
    try {
      const next = await window.aiOffice.stopDocumentFolderScan()
      if (mountedRef.current && next) setFolderScan(next)
    } catch {
      if (mountedRef.current) setActionError(t('error'))
    } finally {
      if (mountedRef.current) setScanBusy(false)
    }
  }

  const modelLabel =
    !status || status.modelState === 'not-loaded'
      ? t('starting')
      : status.modelState === 'downloading'
        ? t('downloading', { progress: Math.round(status.modelProgress ?? 0) })
        : status.modelState === 'ready'
          ? t('ready')
          : t('modelError')

  return (
    <section className="set-memory" aria-label={t('title')}>
      <h4 className="set-field-label">{t('title')}</h4>
      <p className="set-field-desc">{t('description')}</p>
      <div className="set-field set-field-top">
        <div className="set-field-text">
          <div className="set-field-label">{t('enabled')}</div>
        </div>
        <button
          className="set-switch"
          type="button"
          role="switch"
          aria-checked={status?.enabled ?? false}
          disabled={!status || busy}
          onClick={() =>
            void perform(() => window.aiOffice.setDocumentMemoryEnabled(!status?.enabled))
          }
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{t('model')}</div>
        </div>
        <div className="set-field-value">{modelLabel}</div>
      </div>
      {status && (
        <div className="set-field-desc" aria-live="polite">
          {t('docs')}: {status.documents} · {t('chunks')}: {status.chunks} · {t('vectors')}:{' '}
          {status.vectors} · {t('pending')}: {status.pending} · {t('errors')}: {status.errors}
        </div>
      )}
      <IndexingModeSettings />
      <h4 className="set-field-label">{scanT('title')}</h4>
      <div className="set-field" aria-live="polite">
        <div className="set-field-text">
          {folderScan?.running ? (
            <>
              <div className="set-field-label" title={folderScan.root}>
                {scanT('running', { folder: folderScan.root || '…' })}
              </div>
              <div className="set-field-desc">
                {scanT('progress', { count: folderScan.discovered })}
              </div>
            </>
          ) : folderScan?.state === 'complete' ? (
            <>
              <div className="set-field-label">
                {scanT('complete', { count: folderScan.discovered })}
              </div>
              <div className="set-field-desc" title={folderScan.root}>
                {folderScan.root}
              </div>
            </>
          ) : folderScan?.state === 'stopped' ? (
            <>
              <div className="set-field-label">
                {scanT('stopped', { count: folderScan.discovered })}
              </div>
              {folderScan.root && (
                <div className="set-field-desc" title={folderScan.root}>
                  {folderScan.root}
                </div>
              )}
            </>
          ) : null}
          {folderScan && (
            <div className="set-field-desc">
              {scanT('counts', {
                enrolled: folderScan.enrolled,
                skipped: folderScan.skipped,
                errors: folderScan.errors,
              })}
            </div>
          )}
          {!folderScan?.running && (status?.pending ?? 0) > 0 && (
            <div className="set-field-desc">
              {scanT('embedding', { count: status?.pending ?? 0 })}
            </div>
          )}
          {folderScan?.lastError && <div className="set-field-desc">{folderScan.lastError}</div>}
        </div>
        {folderScan?.running ? (
          <button className="set-btn" disabled={scanBusy} onClick={() => void stopFolderScan()}>
            {scanT('stop')}
          </button>
        ) : (
          <button className="set-btn" disabled={scanBusy || busy} onClick={() => void scanFolder()}>
            {scanT('choose')}
          </button>
        )}
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{t('location')}</div>
        </div>
        <div className="set-field-value" title={status?.dbPath}>
          {status?.dbPath || '—'}
        </div>
      </div>
      <h4 className="set-field-label">{t('recent')}</h4>
      {!status?.files.length && <p className="set-field-desc">{t('empty')}</p>}
      {status?.files.map((file) => (
        <div className="set-field" key={file.id}>
          <div className="set-field-text">
            <div className="set-field-label" title={file.path}>
              {file.name}
            </div>
            <div className="set-field-desc">{file.status}</div>
          </div>
          <button
            className="set-btn"
            disabled={busy}
            onClick={() => void perform(() => window.aiOffice.excludeDocumentMemory(file.path))}
          >
            {t('exclude')}
          </button>
        </div>
      ))}
      {actionError && (
        <p className="set-field-desc" role="alert">
          {actionError}
        </p>
      )}
      {confirming ? (
        <div className="set-field">
          <span className="set-field-desc">{t('confirmClear')}</span>
          <button
            className="set-btn"
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              void perform(() => window.aiOffice.clearDocumentMemory())
            }}
          >
            {t('confirm')}
          </button>
          <button className="set-btn" disabled={busy} onClick={() => setConfirming(false)}>
            {t('cancel')}
          </button>
        </div>
      ) : (
        <div className="set-field">
          <span />
          <button
            className="set-btn"
            disabled={busy || !status}
            onClick={() => setConfirming(true)}
          >
            {t('clear')}
          </button>
        </div>
      )}
    </section>
  )
}
