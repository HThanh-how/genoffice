import { useEffect, useRef, useState } from 'react'
import { IndexProgressRing } from '@genoffice/ui'
import '@genoffice/ui/index-progress.css'
import type { HomeApi } from '../../shared/home-api'
import type { Lang } from '@genoffice/i18n'
import './indexing-activity.css'

type Activity = Awaited<ReturnType<HomeApi['getIndexingActivity']>>

const en = {
  title: 'Document index',
  scanning: 'Finding documents',
  indexing: 'Indexing contents',
  done: 'Index complete',
  paused: 'Index paused',
  stopped: 'Finding files stopped',
  error: 'Some files need attention',
  downloading: 'Downloading local model',
  found: 'Found',
  ready: 'Ready',
  waiting: 'Waiting',
  errors: 'Errors',
  stop: 'Stop finding files',
  close: 'Collapse',
  dismiss: 'Dismiss',
  open: 'Show index progress',
  local: 'Processing on this device',
}
const strings: Record<Lang, typeof en> = {
  en,
  zh: {
    title: '文档索引',
    scanning: '正在查找文档',
    indexing: '正在索引内容',
    done: '索引完成',
    paused: '索引已暂停',
    stopped: '查找文件已停止',
    error: '部分文件需要处理',
    downloading: '正在下载本地模型',
    found: '已找到',
    ready: '已完成',
    waiting: '等待中',
    errors: '错误',
    stop: '停止查找文件',
    close: '收起',
    dismiss: '关闭',
    open: '显示索引进度',
    local: '在此设备上处理',
  },
  ja: {
    title: 'ドキュメントの索引',
    scanning: 'ドキュメントを検索中',
    indexing: '内容を索引中',
    done: '索引が完了しました',
    paused: '索引を一時停止しました',
    stopped: 'ファイル検索を停止しました',
    error: '対応が必要なファイルがあります',
    downloading: 'ローカルモデルをダウンロード中',
    found: '検出',
    ready: '完了',
    waiting: '待機中',
    errors: 'エラー',
    stop: 'ファイル検索を停止',
    close: '折りたたむ',
    dismiss: '閉じる',
    open: '索引の進行状況を表示',
    local: 'このデバイスで処理',
  },
  ko: {
    title: '문서 색인',
    scanning: '문서 찾는 중',
    indexing: '내용 색인 중',
    done: '색인 완료',
    paused: '색인 일시 중지됨',
    stopped: '파일 찾기 중지됨',
    error: '확인이 필요한 파일이 있습니다',
    downloading: '로컬 모델 다운로드 중',
    found: '찾음',
    ready: '완료',
    waiting: '대기 중',
    errors: '오류',
    stop: '파일 찾기 중지',
    close: '접기',
    dismiss: '닫기',
    open: '색인 진행 상황 표시',
    local: '이 기기에서 처리',
  },
  fr: {
    title: 'Index des documents',
    scanning: 'Recherche de documents',
    indexing: 'Indexation du contenu',
    done: 'Indexation terminée',
    paused: 'Indexation en pause',
    stopped: 'Recherche de fichiers arrêtée',
    error: 'Certains fichiers nécessitent une attention',
    downloading: 'Téléchargement du modèle local',
    found: 'Trouvés',
    ready: 'Prêts',
    waiting: 'En attente',
    errors: 'Erreurs',
    stop: 'Arrêter la recherche de fichiers',
    close: 'Réduire',
    dismiss: 'Masquer',
    open: 'Afficher la progression de l’indexation',
    local: 'Traitement sur cet appareil',
  },
  de: {
    title: 'Dokumentindex',
    scanning: 'Dokumente werden gesucht',
    indexing: 'Inhalte werden indexiert',
    done: 'Indexierung abgeschlossen',
    paused: 'Indexierung pausiert',
    stopped: 'Dateisuche angehalten',
    error: 'Einige Dateien benötigen Aufmerksamkeit',
    downloading: 'Lokales Modell wird heruntergeladen',
    found: 'Gefunden',
    ready: 'Fertig',
    waiting: 'Wartend',
    errors: 'Fehler',
    stop: 'Dateisuche anhalten',
    close: 'Einklappen',
    dismiss: 'Ausblenden',
    open: 'Indexierungsfortschritt anzeigen',
    local: 'Verarbeitung auf diesem Gerät',
  },
  es: {
    title: 'Índice de documentos',
    scanning: 'Buscando documentos',
    indexing: 'Indexando contenido',
    done: 'Indexación completada',
    paused: 'Indexación pausada',
    stopped: 'Búsqueda de archivos detenida',
    error: 'Algunos archivos requieren atención',
    downloading: 'Descargando el modelo local',
    found: 'Encontrados',
    ready: 'Listos',
    waiting: 'En espera',
    errors: 'Errores',
    stop: 'Detener búsqueda de archivos',
    close: 'Contraer',
    dismiss: 'Ocultar',
    open: 'Mostrar progreso de indexación',
    local: 'Procesamiento en este dispositivo',
  },
  th: {
    title: 'ดัชนีเอกสาร',
    scanning: 'กำลังค้นหาเอกสาร',
    indexing: 'กำลังจัดทำดัชนีเนื้อหา',
    done: 'จัดทำดัชนีเสร็จแล้ว',
    paused: 'หยุดจัดทำดัชนีชั่วคราว',
    stopped: 'หยุดค้นหาไฟล์แล้ว',
    error: 'มีบางไฟล์ที่ต้องตรวจสอบ',
    downloading: 'กำลังดาวน์โหลดโมเดลในเครื่อง',
    found: 'พบ',
    ready: 'พร้อมแล้ว',
    waiting: 'กำลังรอ',
    errors: 'ข้อผิดพลาด',
    stop: 'หยุดค้นหาไฟล์',
    close: 'ย่อ',
    dismiss: 'ซ่อน',
    open: 'แสดงความคืบหน้าการจัดทำดัชนี',
    local: 'ประมวลผลบนอุปกรณ์นี้',
  },
  id: {
    title: 'Indeks dokumen',
    scanning: 'Mencari dokumen',
    indexing: 'Mengindeks konten',
    done: 'Pengindeksan selesai',
    paused: 'Pengindeksan dijeda',
    stopped: 'Pencarian file dihentikan',
    error: 'Beberapa file perlu diperhatikan',
    downloading: 'Mengunduh model lokal',
    found: 'Ditemukan',
    ready: 'Siap',
    waiting: 'Menunggu',
    errors: 'Kesalahan',
    stop: 'Hentikan pencarian file',
    close: 'Ciutkan',
    dismiss: 'Tutup',
    open: 'Tampilkan progres pengindeksan',
    local: 'Diproses di perangkat ini',
  },
  ru: {
    title: 'Индекс документов',
    scanning: 'Поиск документов',
    indexing: 'Индексация содержимого',
    done: 'Индексация завершена',
    paused: 'Индексация приостановлена',
    stopped: 'Поиск файлов остановлен',
    error: 'Некоторым файлам требуется внимание',
    downloading: 'Загрузка локальной модели',
    found: 'Найдено',
    ready: 'Готово',
    waiting: 'Ожидание',
    errors: 'Ошибки',
    stop: 'Остановить поиск файлов',
    close: 'Свернуть',
    dismiss: 'Скрыть',
    open: 'Показать ход индексации',
    local: 'Обработка на этом устройстве',
  },
  ar: {
    title: 'فهرس المستندات',
    scanning: 'جارٍ البحث عن المستندات',
    indexing: 'جارٍ فهرسة المحتوى',
    done: 'اكتملت الفهرسة',
    paused: 'الفهرسة متوقفة مؤقتًا',
    stopped: 'توقف البحث عن الملفات',
    error: 'توجد ملفات تحتاج إلى مراجعة',
    downloading: 'جارٍ تنزيل النموذج المحلي',
    found: 'تم العثور على',
    ready: 'جاهز',
    waiting: 'قيد الانتظار',
    errors: 'أخطاء',
    stop: 'إيقاف البحث عن الملفات',
    close: 'طي',
    dismiss: 'إخفاء',
    open: 'عرض تقدم الفهرسة',
    local: 'تتم المعالجة على هذا الجهاز',
  },
  pt: {
    title: 'Índice de documentos',
    scanning: 'Procurando documentos',
    indexing: 'Indexando conteúdo',
    done: 'Indexação concluída',
    paused: 'Indexação pausada',
    stopped: 'Busca de arquivos interrompida',
    error: 'Alguns arquivos precisam de atenção',
    downloading: 'Baixando modelo local',
    found: 'Encontrados',
    ready: 'Prontos',
    waiting: 'Aguardando',
    errors: 'Erros',
    stop: 'Parar busca de arquivos',
    close: 'Recolher',
    dismiss: 'Ocultar',
    open: 'Mostrar progresso da indexação',
    local: 'Processamento neste dispositivo',
  },
  it: {
    title: 'Indice dei documenti',
    scanning: 'Ricerca dei documenti',
    indexing: 'Indicizzazione dei contenuti',
    done: 'Indicizzazione completata',
    paused: 'Indicizzazione in pausa',
    stopped: 'Ricerca dei file interrotta',
    error: 'Alcuni file richiedono attenzione',
    downloading: 'Download del modello locale',
    found: 'Trovati',
    ready: 'Pronti',
    waiting: 'In attesa',
    errors: 'Errori',
    stop: 'Interrompi la ricerca dei file',
    close: 'Comprimi',
    dismiss: 'Nascondi',
    open: 'Mostra avanzamento indicizzazione',
    local: 'Elaborazione su questo dispositivo',
  },
  pl: {
    title: 'Indeks dokumentów',
    scanning: 'Wyszukiwanie dokumentów',
    indexing: 'Indeksowanie zawartości',
    done: 'Indeksowanie ukończone',
    paused: 'Indeksowanie wstrzymane',
    stopped: 'Wyszukiwanie plików zatrzymane',
    error: 'Niektóre pliki wymagają uwagi',
    downloading: 'Pobieranie modelu lokalnego',
    found: 'Znaleziono',
    ready: 'Gotowe',
    waiting: 'Oczekuje',
    errors: 'Błędy',
    stop: 'Zatrzymaj wyszukiwanie plików',
    close: 'Zwiń',
    dismiss: 'Ukryj',
    open: 'Pokaż postęp indeksowania',
    local: 'Przetwarzanie na tym urządzeniu',
  },
  cs: {
    title: 'Index dokumentů',
    scanning: 'Vyhledávání dokumentů',
    indexing: 'Indexování obsahu',
    done: 'Indexování dokončeno',
    paused: 'Indexování pozastaveno',
    stopped: 'Vyhledávání souborů zastaveno',
    error: 'Některé soubory vyžadují pozornost',
    downloading: 'Stahování místního modelu',
    found: 'Nalezeno',
    ready: 'Připraveno',
    waiting: 'Čeká',
    errors: 'Chyby',
    stop: 'Zastavit vyhledávání souborů',
    close: 'Sbalit',
    dismiss: 'Skrýt',
    open: 'Zobrazit průběh indexování',
    local: 'Zpracování na tomto zařízení',
  },
  nl: {
    title: 'Documentindex',
    scanning: 'Documenten zoeken',
    indexing: 'Inhoud indexeren',
    done: 'Indexering voltooid',
    paused: 'Indexering gepauzeerd',
    stopped: 'Bestanden zoeken gestopt',
    error: 'Sommige bestanden vereisen aandacht',
    downloading: 'Lokaal model downloaden',
    found: 'Gevonden',
    ready: 'Gereed',
    waiting: 'Wachtend',
    errors: 'Fouten',
    stop: 'Bestanden zoeken stoppen',
    close: 'Inklappen',
    dismiss: 'Verbergen',
    open: 'Voortgang van indexering weergeven',
    local: 'Verwerking op dit apparaat',
  },
  ms: {
    title: 'Indeks dokumen',
    scanning: 'Mencari dokumen',
    indexing: 'Mengindeks kandungan',
    done: 'Pengindeksan selesai',
    paused: 'Pengindeksan dijeda',
    stopped: 'Carian fail dihentikan',
    error: 'Sesetengah fail memerlukan perhatian',
    downloading: 'Memuat turun model setempat',
    found: 'Ditemui',
    ready: 'Sedia',
    waiting: 'Menunggu',
    errors: 'Ralat',
    stop: 'Hentikan carian fail',
    close: 'Runtuhkan',
    dismiss: 'Sembunyikan',
    open: 'Tunjukkan kemajuan pengindeksan',
    local: 'Diproses pada peranti ini',
  },
  he: {
    title: 'אינדקס מסמכים',
    scanning: 'מחפש מסמכים',
    indexing: 'מאנדקס תוכן',
    done: 'האינדוקס הושלם',
    paused: 'האינדוקס מושהה',
    stopped: 'חיפוש הקבצים נעצר',
    error: 'יש קבצים שדורשים טיפול',
    downloading: 'מוריד מודל מקומי',
    found: 'נמצאו',
    ready: 'מוכנים',
    waiting: 'בהמתנה',
    errors: 'שגיאות',
    stop: 'עצור חיפוש קבצים',
    close: 'כווץ',
    dismiss: 'הסתר',
    open: 'הצג את התקדמות האינדוקס',
    local: 'העיבוד מתבצע במכשיר הזה',
  },
  hi: {
    title: 'दस्तावेज़ अनुक्रमणिका',
    scanning: 'दस्तावेज़ खोजे जा रहे हैं',
    indexing: 'सामग्री अनुक्रमित हो रही है',
    done: 'अनुक्रमण पूरा हुआ',
    paused: 'अनुक्रमण रुका हुआ है',
    stopped: 'फ़ाइल खोजना बंद हुआ',
    error: 'कुछ फ़ाइलों पर ध्यान देना होगा',
    downloading: 'स्थानीय मॉडल डाउनलोड हो रहा है',
    found: 'मिले',
    ready: 'तैयार',
    waiting: 'प्रतीक्षा में',
    errors: 'त्रुटियाँ',
    stop: 'फ़ाइल खोजना रोकें',
    close: 'समेटें',
    dismiss: 'छिपाएँ',
    open: 'अनुक्रमण की प्रगति दिखाएँ',
    local: 'इस डिवाइस पर संसाधित',
  },
  'zh-TW': {
    title: '文件索引',
    scanning: '正在尋找文件',
    indexing: '正在索引內容',
    done: '索引完成',
    paused: '索引已暫停',
    stopped: '已停止尋找檔案',
    error: '部分檔案需要處理',
    downloading: '正在下載本機模型',
    found: '已找到',
    ready: '已完成',
    waiting: '等待中',
    errors: '錯誤',
    stop: '停止尋找檔案',
    close: '收合',
    dismiss: '隱藏',
    open: '顯示索引進度',
    local: '在此裝置上處理',
  },
  vi: {
    title: 'Chỉ mục tài liệu',
    scanning: 'Đang tìm tài liệu',
    indexing: 'Đang lập chỉ mục',
    done: 'Đã lập chỉ mục',
    paused: 'Đã tạm dừng',
    stopped: 'Đã dừng tìm tệp',
    error: 'Có tệp cần kiểm tra',
    downloading: 'Đang tải mô hình cục bộ',
    found: 'Đã tìm',
    ready: 'Hoàn tất',
    waiting: 'Đang chờ',
    errors: 'Lỗi',
    stop: 'Dừng tìm tệp',
    close: 'Thu gọn',
    dismiss: 'Ẩn',
    open: 'Xem tiến độ lập chỉ mục',
    local: 'Xử lý trên máy này',
  },
}

export function IndexingActivity({ api, lang }: { api: HomeApi; lang: Lang }) {
  const [activity, setActivity] = useState<Activity | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const lastJob = useRef('')
  const lastActive = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const words = strings[lang] ?? en
  useEffect(() => {
    mounted.current = true
    let busy = false
    const refresh = async () => {
      if (busy || !api.getIndexingActivity) return
      busy = true
      try {
        const next = await api.getIndexingActivity()
        if (!mounted.current) return
        setActivity(next)
        const root = next.folder?.root ?? ''
        const job = `${root}:${next.folder?.startedAt ?? ''}`
        const active =
          next.memory.enabled &&
          (!!next.folder?.running || (next.folderProgress?.pendingFiles ?? 0) > 0)
        if (root && (job !== lastJob.current || (active && !lastActive.current))) {
          setDismissed(false)
          setExpanded(true)
        }
        lastJob.current = job
        lastActive.current = active
      } catch {
        // Older standalone shells can omit the progress bridge.
      } finally {
        busy = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [api])
  useEffect(() => {
    if (!expanded) return
    const collapse = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target))
        setExpanded(false)
    }
    document.addEventListener('pointerdown', collapse, true)
    return () => document.removeEventListener('pointerdown', collapse, true)
  }, [expanded])
  const folder = activity?.folder
  const progress = activity?.folderProgress
  if (!folder?.root || dismissed) return null
  const pendingFiles = progress?.pendingFiles ?? 0
  const hasErrors =
    folder.errors > 0 ||
    (progress?.errorFiles ?? 0) > 0 ||
    (activity?.memory.modelState === 'error' && pendingFiles > 0)
  const paused = !activity?.memory.enabled
  const stopped = folder.state === 'stopped'
  const complete =
    !stopped && !paused && !hasErrors && !folder.running && !!progress && pendingFiles === 0
  const ringState = hasErrors ? 'error' : paused ? 'paused' : 'running'
  const percent =
    folder.running || paused || hasErrors || (stopped && !progress?.pendingFiles)
      ? null
      : (progress?.percent ?? null)
  const label = paused
    ? words.paused
    : folder.running
      ? words.scanning
      : hasErrors
        ? words.error
        : stopped && !progress?.pendingFiles
          ? words.stopped
          : complete
            ? words.done
            : activity?.memory.modelState === 'downloading'
              ? words.downloading
              : words.indexing
  const ringPercent = complete ? 100 : percent
  const folderName = folder.root.split(/[\\/]/).filter(Boolean).at(-1) || folder.root
  return (
    <div className="indexing-activity" ref={rootRef}>
      {expanded && (
        <section className="indexing-activity-panel" aria-label={words.title}>
          <header>
            <strong>{words.title}</strong>
            <button type="button" aria-label={words.close} onClick={() => setExpanded(false)}>
              ×
            </button>
          </header>
          <div className="indexing-activity-current">
            <IndexProgressRing
              percent={ringPercent}
              complete={complete}
              state={ringState}
              active={!paused && !hasErrors && (folder.running || pendingFiles > 0)}
              label={label}
            />
            <div>
              <strong>{label}</strong>
              <span title={folder.root}>{folderName}</span>
            </div>
          </div>
          <div className="indexing-activity-counts" aria-live="polite">
            <span>
              {words.found}
              <strong>{folder.discovered}</strong>
            </span>
            <span>
              {words.ready}
              <strong>{progress?.readyFiles ?? 0}</strong>
            </span>
            <span>
              {words.waiting}
              <strong>{progress?.pendingFiles ?? 0}</strong>
            </span>
            <span>
              {words.errors}
              <strong>{folder.errors + (progress?.errorFiles ?? 0)}</strong>
            </span>
          </div>
          {activity?.memory.modelState === 'downloading' && (
            <p>
              {words.downloading} · {Math.round(activity.memory.modelProgress ?? 0)}%
            </p>
          )}
          {folder.lastError && <p role="alert">{folder.lastError}</p>}
          <footer>
            <span>{words.local}</span>
            {folder.running ? (
              <button
                type="button"
                onClick={() => void api.stopDocumentFolderScan().catch(() => undefined)}
              >
                {words.stop}
              </button>
            ) : (
              <button type="button" onClick={() => setDismissed(true)}>
                {words.dismiss}
              </button>
            )}
          </footer>
        </section>
      )}
      <button
        type="button"
        className="indexing-activity-launcher"
        aria-label={words.open}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <IndexProgressRing
          percent={ringPercent}
          complete={complete}
          state={ringState}
          active={!paused && !hasErrors && (folder.running || pendingFiles > 0)}
          label={label}
        />
        <span>
          <strong>{label}</strong>
          <small>{folderName}</small>
        </span>
      </button>
    </div>
  )
}
