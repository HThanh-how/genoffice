import React, { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import './index-progress.css'

export interface DocumentIndexProgress {
  path?: string
  name?: string
  state:
    | 'idle'
    | 'queued'
    | 'extracting'
    | 'indexing'
    | 'ready'
    | 'empty'
    | 'error'
    | 'excluded'
    | 'paused'
  percent: number | null
  completedChunks: number
  totalChunks: number
  error?: string
}

export interface IndexProgressRingProps {
  percent: number | null
  complete?: boolean
  label: string
  active?: boolean
  state?: 'running' | 'paused' | 'error'
  valueText?: string
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 13

export function IndexProgressRing({
  percent,
  complete = false,
  label,
  active = true,
  state = 'running',
  valueText,
}: IndexProgressRingProps): React.JSX.Element {
  const determinate =
    active && !complete && state === 'running' && percent !== null && Number.isFinite(percent)
  const boundedPercent = determinate ? Math.max(0, Math.min(100, Math.round(percent))) : 0
  const spokenValue = valueText ?? (complete ? label : determinate ? `${boundedPercent}%` : label)
  const describedLabel = `${label}: ${spokenValue}`

  return (
    <svg
      className={`index-progress-ring is-${state}${complete ? ' is-complete' : ''}`}
      viewBox="0 0 32 32"
      role="progressbar"
      aria-label={describedLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={complete ? 100 : determinate ? boundedPercent : undefined}
      aria-valuetext={spokenValue}
    >
      {!complete && <circle className="index-progress-ring-track" cx="16" cy="16" r="13" />}
      {complete ? (
        <circle className="index-progress-ring-dot" cx="16" cy="16" r="6" />
      ) : state === 'error' ? (
        <path className="index-progress-ring-symbol" d="M16 9.5v8m0 4v.1" />
      ) : state === 'paused' ? (
        <path className="index-progress-ring-symbol" d="M13 11v10m6-10v10" />
      ) : (
        <circle
          className={`index-progress-ring-value${determinate ? '' : active ? ' is-indeterminate' : ' is-idle'}`}
          cx="16"
          cy="16"
          r="13"
          strokeDasharray={determinate ? RING_CIRCUMFERENCE : active ? undefined : '24 58'}
          strokeDashoffset={
            determinate ? RING_CIRCUMFERENCE * (1 - boundedPercent / 100) : undefined
          }
        />
      )}
      {determinate && (
        <text className="index-progress-ring-percent" x="16" y="16">
          {boundedPercent}%
        </text>
      )}
    </svg>
  )
}

type IndexStrings = {
  index: string
  queued: string
  extracting: string
  indexing: string
  ready: string
  empty: string
  error: string
  excluded: string
  paused: string
  chunks: string
  percent: string
}

const INDEX_STRINGS: Record<Lang, IndexStrings> = {
  zh: {
    index: '索引',
    queued: '等待索引',
    extracting: '正在读取文档',
    indexing: '正在建立索引',
    ready: '索引已完成',
    empty: '没有可索引内容',
    error: '索引失败',
    excluded: '已从索引中排除',
    paused: '索引已暂停',
    chunks: '内容块',
    percent: '{value}%',
  },
  en: {
    index: 'Index',
    queued: 'Waiting to index',
    extracting: 'Reading document',
    indexing: 'Indexing document',
    ready: 'Indexing complete',
    empty: 'No indexable content',
    error: 'Indexing failed',
    excluded: 'Excluded from indexing',
    paused: 'Indexing paused',
    chunks: 'chunks',
    percent: '{value}%',
  },
  ja: {
    index: '索引',
    queued: '索引待ち',
    extracting: '文書を読み込み中',
    indexing: '文書を索引中',
    ready: '索引が完了しました',
    empty: '索引可能な内容がありません',
    error: '索引に失敗しました',
    excluded: '索引から除外されています',
    paused: '索引を一時停止しました',
    chunks: 'チャンク',
    percent: '{value}%',
  },
  ko: {
    index: '색인',
    queued: '색인 대기 중',
    extracting: '문서 읽는 중',
    indexing: '문서 색인 중',
    ready: '색인 완료',
    empty: '색인할 내용이 없습니다',
    error: '색인 실패',
    excluded: '색인에서 제외됨',
    paused: '색인 일시 중지됨',
    chunks: '청크',
    percent: '{value}%',
  },
  fr: {
    index: 'Index',
    queued: 'En attente d’indexation',
    extracting: 'Lecture du document',
    indexing: 'Indexation du document',
    ready: 'Indexation terminée',
    empty: 'Aucun contenu indexable',
    error: 'Échec de l’indexation',
    excluded: 'Exclu de l’indexation',
    paused: 'Indexation en pause',
    chunks: 'blocs',
    percent: '{value} %',
  },
  de: {
    index: 'Index',
    queued: 'Wartet auf Indexierung',
    extracting: 'Dokument wird gelesen',
    indexing: 'Dokument wird indexiert',
    ready: 'Indexierung abgeschlossen',
    empty: 'Keine indexierbaren Inhalte',
    error: 'Indexierung fehlgeschlagen',
    excluded: 'Von der Indexierung ausgeschlossen',
    paused: 'Indexierung pausiert',
    chunks: 'Abschnitte',
    percent: '{value} %',
  },
  es: {
    index: 'Índice',
    queued: 'En espera de indexación',
    extracting: 'Leyendo documento',
    indexing: 'Indexando documento',
    ready: 'Indexación completada',
    empty: 'No hay contenido indexable',
    error: 'Error al indexar',
    excluded: 'Excluido de la indexación',
    paused: 'Indexación pausada',
    chunks: 'fragmentos',
    percent: '{value} %',
  },
  th: {
    index: 'ดัชนี',
    queued: 'รอจัดทำดัชนี',
    extracting: 'กำลังอ่านเอกสาร',
    indexing: 'กำลังจัดทำดัชนีเอกสาร',
    ready: 'จัดทำดัชนีเสร็จแล้ว',
    empty: 'ไม่มีเนื้อหาที่จัดทำดัชนีได้',
    error: 'จัดทำดัชนีไม่สำเร็จ',
    excluded: 'ยกเว้นจากการจัดทำดัชนี',
    paused: 'หยุดการจัดทำดัชนีชั่วคราว',
    chunks: 'ส่วนเนื้อหา',
    percent: '{value}%',
  },
  id: {
    index: 'Indeks',
    queued: 'Menunggu pengindeksan',
    extracting: 'Membaca dokumen',
    indexing: 'Mengindeks dokumen',
    ready: 'Pengindeksan selesai',
    empty: 'Tidak ada konten yang dapat diindeks',
    error: 'Pengindeksan gagal',
    excluded: 'Dikecualikan dari indeks',
    paused: 'Pengindeksan dijeda',
    chunks: 'bagian',
    percent: '{value}%',
  },
  ru: {
    index: 'Индекс',
    queued: 'Ожидание индексации',
    extracting: 'Чтение документа',
    indexing: 'Индексация документа',
    ready: 'Индексация завершена',
    empty: 'Нет данных для индексации',
    error: 'Ошибка индексации',
    excluded: 'Исключено из индексации',
    paused: 'Индексация приостановлена',
    chunks: 'фрагментов',
    percent: '{value}%',
  },
  ar: {
    index: 'الفهرسة',
    queued: 'بانتظار الفهرسة',
    extracting: 'جارٍ قراءة المستند',
    indexing: 'جارٍ فهرسة المستند',
    ready: 'اكتملت الفهرسة',
    empty: 'لا يوجد محتوى قابل للفهرسة',
    error: 'فشلت الفهرسة',
    excluded: 'مستبعد من الفهرسة',
    paused: 'الفهرسة متوقفة مؤقتًا',
    chunks: 'مقاطع',
    percent: '{value}٪',
  },
  pt: {
    index: 'Índice',
    queued: 'Aguardando indexação',
    extracting: 'Lendo documento',
    indexing: 'Indexando documento',
    ready: 'Indexação concluída',
    empty: 'Nenhum conteúdo indexável',
    error: 'Falha na indexação',
    excluded: 'Excluído da indexação',
    paused: 'Indexação pausada',
    chunks: 'blocos',
    percent: '{value}%',
  },
  it: {
    index: 'Indice',
    queued: 'In attesa di indicizzazione',
    extracting: 'Lettura del documento',
    indexing: 'Indicizzazione del documento',
    ready: 'Indicizzazione completata',
    empty: 'Nessun contenuto indicizzabile',
    error: 'Indicizzazione non riuscita',
    excluded: 'Escluso dall’indicizzazione',
    paused: 'Indicizzazione in pausa',
    chunks: 'blocchi',
    percent: '{value}%',
  },
  pl: {
    index: 'Indeks',
    queued: 'Oczekiwanie na indeksowanie',
    extracting: 'Odczytywanie dokumentu',
    indexing: 'Indeksowanie dokumentu',
    ready: 'Indeksowanie ukończone',
    empty: 'Brak treści do indeksowania',
    error: 'Indeksowanie nie powiodło się',
    excluded: 'Wykluczono z indeksowania',
    paused: 'Indeksowanie wstrzymane',
    chunks: 'fragmentów',
    percent: '{value}%',
  },
  cs: {
    index: 'Index',
    queued: 'Čeká na indexování',
    extracting: 'Čtení dokumentu',
    indexing: 'Indexování dokumentu',
    ready: 'Indexování dokončeno',
    empty: 'Žádný obsah k indexování',
    error: 'Indexování se nezdařilo',
    excluded: 'Vyloučeno z indexování',
    paused: 'Indexování pozastaveno',
    chunks: 'částí',
    percent: '{value} %',
  },
  nl: {
    index: 'Index',
    queued: 'Wacht op indexering',
    extracting: 'Document wordt gelezen',
    indexing: 'Document wordt geïndexeerd',
    ready: 'Indexering voltooid',
    empty: 'Geen indexeerbare inhoud',
    error: 'Indexering mislukt',
    excluded: 'Uitgesloten van indexering',
    paused: 'Indexering gepauzeerd',
    chunks: 'delen',
    percent: '{value}%',
  },
  ms: {
    index: 'Indeks',
    queued: 'Menunggu pengindeksan',
    extracting: 'Membaca dokumen',
    indexing: 'Mengindeks dokumen',
    ready: 'Pengindeksan selesai',
    empty: 'Tiada kandungan untuk diindeks',
    error: 'Pengindeksan gagal',
    excluded: 'Dikecualikan daripada indeks',
    paused: 'Pengindeksan dijeda',
    chunks: 'bahagian',
    percent: '{value}%',
  },
  he: {
    index: 'אינדקס',
    queued: 'ממתין לאינדוקס',
    extracting: 'קורא את המסמך',
    indexing: 'מאנדקס את המסמך',
    ready: 'האינדוקס הושלם',
    empty: 'אין תוכן שניתן לאנדקס',
    error: 'האינדוקס נכשל',
    excluded: 'הוחרג מהאינדוקס',
    paused: 'האינדוקס מושהה',
    chunks: 'קטעים',
    percent: '{value}%',
  },
  hi: {
    index: 'अनुक्रमणिका',
    queued: 'अनुक्रमण की प्रतीक्षा',
    extracting: 'दस्तावेज़ पढ़ा जा रहा है',
    indexing: 'दस्तावेज़ अनुक्रमित हो रहा है',
    ready: 'अनुक्रमण पूरा हुआ',
    empty: 'अनुक्रमित करने योग्य सामग्री नहीं है',
    error: 'अनुक्रमण विफल',
    excluded: 'अनुक्रमण से बाहर रखा गया',
    paused: 'अनुक्रमण रुका हुआ है',
    chunks: 'खंड',
    percent: '{value}%',
  },
  'zh-TW': {
    index: '索引',
    queued: '等待索引',
    extracting: '正在讀取文件',
    indexing: '正在建立索引',
    ready: '索引已完成',
    empty: '沒有可索引內容',
    error: '索引失敗',
    excluded: '已從索引中排除',
    paused: '索引已暫停',
    chunks: '內容區塊',
    percent: '{value}%',
  },
  vi: {
    index: 'Index',
    queued: 'Đang chờ lập chỉ mục',
    extracting: 'Đang đọc tài liệu',
    indexing: 'Đang lập chỉ mục tài liệu',
    ready: 'Đã lập chỉ mục xong',
    empty: 'Không có nội dung để lập chỉ mục',
    error: 'Lập chỉ mục thất bại',
    excluded: 'Đã loại khỏi chỉ mục',
    paused: 'Đã tạm dừng lập chỉ mục',
    chunks: 'đoạn',
    percent: '{value}%',
  },
}

export interface DocumentIndexIndicatorProps {
  path?: string | null
  api?: { getDocumentIndexProgress(path: string): Promise<DocumentIndexProgress> }
  lang?: Lang
}

const POLL_INTERVAL_MS = 1_000

export function DocumentIndexIndicator({
  path,
  api,
  lang = 'en',
}: DocumentIndexIndicatorProps): React.JSX.Element | null {
  const [progress, setProgress] = useState<DocumentIndexProgress | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    let mounted = true
    setProgress(null)
    if (!path || !api || typeof api.getDocumentIndexProgress !== 'function')
      return () => {
        mounted = false
      }

    let busy = false
    const poll = async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        const next = await api.getDocumentIndexProgress(path)
        if (mounted && generationRef.current === generation) setProgress(next)
      } catch {
        // A transient read failure should not replace a useful in-flight status.
      } finally {
        busy = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [path, api])

  if (!path || !progress || progress.state === 'idle') return null

  const strings = INDEX_STRINGS[lang] ?? INDEX_STRINGS.en
  const complete = progress.state === 'ready' || progress.state === 'empty'
  const state =
    progress.state === 'error'
      ? 'error'
      : progress.state === 'paused' || progress.state === 'excluded'
        ? 'paused'
        : 'running'
  const status = strings[progress.state]
  const roundedPercent =
    progress.percent === null || !Number.isFinite(progress.percent)
      ? null
      : Math.max(0, Math.min(100, Math.round(progress.percent)))
  const details = complete
    ? status
    : roundedPercent !== null && state === 'running'
      ? `${status} · ${strings.percent.replace('{value}', String(roundedPercent))}`
      : progress.totalChunks > 0 && state === 'running'
        ? `${status} · ${progress.completedChunks}/${progress.totalChunks} ${strings.chunks}`
        : status

  return (
    <span
      className="document-index-indicator"
      tabIndex={0}
      title={details}
      data-tip={details}
      aria-label={`${strings.index}: ${details}`}
    >
      <IndexProgressRing
        percent={roundedPercent}
        complete={complete}
        state={state}
        label={strings.index}
        valueText={details}
      />
      <span className="document-index-indicator-label">{strings.index}</span>
    </span>
  )
}
