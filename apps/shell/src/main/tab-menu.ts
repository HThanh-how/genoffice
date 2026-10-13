import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import { extname } from 'node:path'
import type { TabSummary } from '../shared/tabs-api'

const EN = {
  save: 'Save',
  saveAs: 'Save As…',
  print: 'Print…',
  rename: 'Rename',
  duplicate: 'Duplicate (copy the saved file)',
  splitBeside: 'Split side by side',
  copyPath: 'Copy path',
  copyName: 'Copy file name',
  reveal: 'Show in folder',
  openDefault: 'Open with the default app',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  closeOthers: 'Close other tabs',
  closeRight: 'Close tabs to the right',
  closeAll: 'Close all tabs',
  reopen: 'Reopen closed tab',
}

const ZH: typeof EN = {
  save: '保存',
  saveAs: '另存为…',
  print: '打印…',
  rename: '重命名',
  duplicate: '创建副本（复制已保存的文件）',
  splitBeside: '左右分屏',
  copyPath: '复制路径',
  copyName: '复制文件名',
  reveal: '在文件夹中显示',
  openDefault: '使用默认应用打开',
  moveLeft: '向左移动',
  moveRight: '向右移动',
  closeOthers: '关闭其他标签页',
  closeRight: '关闭右侧标签页',
  closeAll: '关闭所有标签页',
  reopen: '重新打开关闭的标签页',
}

const ZH_TW: typeof EN = {
  save: '儲存',
  saveAs: '另存新檔…',
  print: '列印…',
  rename: '重新命名',
  duplicate: '建立複本（複製已儲存的檔案）',
  splitBeside: '左右分屏',
  copyPath: '複製路徑',
  copyName: '複製檔案名稱',
  reveal: '在資料夾中顯示',
  openDefault: '使用預設應用程式開啟',
  moveLeft: '向左移動',
  moveRight: '向右移動',
  closeOthers: '關閉其他分頁',
  closeRight: '關閉右側分頁',
  closeAll: '關閉所有分頁',
  reopen: '重新開啟已關閉的分頁',
}

const VI: typeof EN = {
  save: 'Lưu',
  saveAs: 'Lưu thành…',
  print: 'In…',
  rename: 'Đổi tên',
  duplicate: 'Nhân bản (sao chép file đã lưu)',
  splitBeside: 'Chia đôi màn hình',
  copyPath: 'Sao chép đường dẫn',
  copyName: 'Sao chép tên file',
  reveal: 'Mở thư mục chứa file',
  openDefault: 'Mở bằng ứng dụng mặc định',
  moveLeft: 'Dời sang trái',
  moveRight: 'Dời sang phải',
  closeOthers: 'Đóng các thẻ khác',
  closeRight: 'Đóng các thẻ bên phải',
  closeAll: 'Đóng tất cả các thẻ',
  reopen: 'Mở lại thẻ vừa đóng',
}

const JA: typeof EN = {
  save: '保存',
  saveAs: '名前を付けて保存…',
  print: '印刷…',
  rename: '名前を変更',
  duplicate: '複製（保存済みファイルのコピー）',
  splitBeside: '左右に分割',
  copyPath: 'パスをコピー',
  copyName: 'ファイル名をコピー',
  reveal: 'フォルダーで表示',
  openDefault: '既定のアプリで開く',
  moveLeft: '左へ移動',
  moveRight: '右へ移動',
  closeOthers: '他のタブを閉じる',
  closeRight: '右側のタブを閉じる',
  closeAll: 'すべてのタブを閉じる',
  reopen: '閉じたタブを再度開く',
}

const KO: typeof EN = {
  save: '저장',
  saveAs: '다른 이름으로 저장…',
  print: '인쇄…',
  rename: '이름 바꾸기',
  duplicate: '복제(저장된 파일 복사)',
  splitBeside: '나란히 분할',
  copyPath: '경로 복사',
  copyName: '파일 이름 복사',
  reveal: '폴더에서 표시',
  openDefault: '기본 앱으로 열기',
  moveLeft: '왼쪽으로 이동',
  moveRight: '오른쪽으로 이동',
  closeOthers: '다른 탭 닫기',
  closeRight: '오른쪽 탭 닫기',
  closeAll: '모든 탭 닫기',
  reopen: '닫힌 탭 다시 열기',
}

const FR: typeof EN = {
  save: 'Enregistrer',
  saveAs: 'Enregistrer sous…',
  print: 'Imprimer…',
  rename: 'Renommer',
  duplicate: 'Dupliquer (copier le fichier enregistré)',
  splitBeside: 'Afficher côte à côte',
  copyPath: 'Copier le chemin',
  copyName: 'Copier le nom du fichier',
  reveal: 'Afficher dans le dossier',
  openDefault: "Ouvrir avec l'application par défaut",
  moveLeft: 'Déplacer vers la gauche',
  moveRight: 'Déplacer vers la droite',
  closeOthers: 'Fermer les autres onglets',
  closeRight: 'Fermer les onglets à droite',
  closeAll: 'Fermer tous les onglets',
  reopen: "Rouvrir l'onglet fermé",
}

const DE: typeof EN = {
  save: 'Speichern',
  saveAs: 'Speichern unter…',
  print: 'Drucken…',
  rename: 'Umbenennen',
  duplicate: 'Duplizieren (gespeicherte Datei kopieren)',
  splitBeside: 'Nebeneinander teilen',
  copyPath: 'Pfad kopieren',
  copyName: 'Dateinamen kopieren',
  reveal: 'Im Ordner anzeigen',
  openDefault: 'Mit Standard-App öffnen',
  moveLeft: 'Nach links verschieben',
  moveRight: 'Nach rechts verschieben',
  closeOthers: 'Andere Tabs schließen',
  closeRight: 'Rechts liegende Tabs schließen',
  closeAll: 'Alle Tabs schließen',
  reopen: 'Geschlossenen Tab wieder öffnen',
}

const ES: typeof EN = {
  save: 'Guardar',
  saveAs: 'Guardar como…',
  print: 'Imprimir…',
  rename: 'Cambiar nombre',
  duplicate: 'Duplicar (copiar archivo guardado)',
  splitBeside: 'Dividir en paralelo',
  copyPath: 'Copiar ruta',
  copyName: 'Copiar nombre de archivo',
  reveal: 'Mostrar en la carpeta',
  openDefault: 'Abrir con la aplicación predeterminada',
  moveLeft: 'Mover a la izquierda',
  moveRight: 'Mover a la derecha',
  closeOthers: 'Cerrar las demás pestañas',
  closeRight: 'Cerrar pestañas a la derecha',
  closeAll: 'Cerrar todas las pestañas',
  reopen: 'Reabrir pestaña cerrada',
}

const RU: typeof EN = {
  save: 'Сохранить',
  saveAs: 'Сохранить как…',
  print: 'Печать…',
  rename: 'Переименовать',
  duplicate: 'Создать копию (сохранённый файл)',
  splitBeside: 'Разделить экран',
  copyPath: 'Копировать путь',
  copyName: 'Копировать имя файла',
  reveal: 'Показать в папке',
  openDefault: 'Открыть в приложении по умолчанию',
  moveLeft: 'Переместить влево',
  moveRight: 'Переместить вправо',
  closeOthers: 'Закрыть другие вкладки',
  closeRight: 'Закрыть вкладки справа',
  closeAll: 'Закрыть все вкладки',
  reopen: 'Открыть закрытую вкладку',
}

const PT: typeof EN = {
  save: 'Salvar',
  saveAs: 'Salvar como…',
  print: 'Imprimir…',
  rename: 'Renomear',
  duplicate: 'Duplicar (copiar arquivo salvo)',
  splitBeside: 'Dividir lado a lado',
  copyPath: 'Copiar caminho',
  copyName: 'Copiar nome do arquivo',
  reveal: 'Mostrar na pasta',
  openDefault: 'Abrir com aplicativo padrão',
  moveLeft: 'Mover para a esquerda',
  moveRight: 'Mover para a direita',
  closeOthers: 'Fechar outras abas',
  closeRight: 'Fechar abas à direita',
  closeAll: 'Fechar todas as abas',
  reopen: 'Reabrir aba fechada',
}

const IT: typeof EN = {
  save: 'Salva',
  saveAs: 'Salva con nome…',
  print: 'Stampa…',
  rename: 'Rinomina',
  duplicate: 'Duplica (copia il file salvato)',
  splitBeside: 'Affianca',
  copyPath: 'Copia percorso',
  copyName: 'Copia nome file',
  reveal: 'Mostra nella cartella',
  openDefault: "Apri con l'applicazione predefinita",
  moveLeft: 'Sposta a sinistra',
  moveRight: 'Sposta a destra',
  closeOthers: 'Chiudi altre schede',
  closeRight: 'Chiudi schede a destra',
  closeAll: 'Chiudi tutte le schede',
  reopen: 'Riapri scheda chiusa',
}

const DICTS: Record<string, typeof EN> = {
  en: EN,
  zh: ZH,
  'zh-tw': ZH_TW,
  vi: VI,
  ja: JA,
  ko: KO,
  fr: FR,
  de: DE,
  es: ES,
  ru: RU,
  pt: PT,
  it: IT,
}

/** Words for the tab context menu, localized with fallback to English. */
export const tabMenuWords = (lang: string): typeof EN => {
  const key = lang.trim().toLowerCase()
  return DICTS[key] ?? DICTS[key.split(/[-_]/)[0] ?? ''] ?? EN
}

/** What each menu entry does; the shell supplies these, the menu only decides what is offered. */
export interface TabMenuActions {
  save(id: string): void
  saveAs(id: string): void
  print(id: string): void
  openInNewWindow(id: string): void
  splitBeside(id: string): void
  rename(id: string): void
  duplicate(path: string): void
  copyText(text: string): void
  reveal(path: string): void
  openDefault(path: string): void
  move(id: string, toIndex: number): void
  /** close these tabs one after another (a save prompt that is cancelled stops the rest) */
  closeTabs(ids: string[]): void
  reopenClosed(): void
}

export interface TabMenuInput {
  tab: TabSummary
  /** every tab in strip order, Home first */
  tabs: readonly TabSummary[]
  canDetach: boolean
  /** the file behind the tab is still on disk */
  fileExists: boolean
  /** something was closed that can be opened again */
  canReopen: boolean
  words: typeof EN
  /** the shell's existing, fully translated labels */
  labels: { openInNewWindow: string; close: string }
  actions: TabMenuActions
  icons?: Partial<Record<TabMenuIcon, NativeImage>>
}

export type TabMenuIcon = keyof typeof EN | 'openInNewWindow' | 'close'

/** Executable, script, shortcut, and launcher extensions that should not be launched via default app */
const PROGRAM_EXTENSIONS = new Set([
  // Windows executables, scripts, shortcuts, and installers
  '.exe',
  '.com',
  '.scr',
  '.msi',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.hta',
  '.lnk',
  '.url',
  '.reg',
  '.cpl',
  '.pif',
  '.gadget',
  '.msc',
  '.inf',
  '.ins',
  '.isp',
  // macOS applications, scripts, workflows, and packages
  '.app',
  '.command',
  '.action',
  '.workflow',
  '.scpt',
  '.applescript',
  '.terminal',
  '.pkg',
  '.mpkg',
  // Linux launchers, binaries, and shell scripts
  '.desktop',
  '.sh',
  '.bash',
  '.zsh',
  '.csh',
  '.ksh',
  '.bin',
  '.run',
  '.out',
  // Java archives
  '.jar',
])

export function isProgramFile(path: string): boolean {
  return PROGRAM_EXTENSIONS.has(extname(path).toLowerCase())
}

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

const PATH_LABEL_MAX = 80

/**
 * A path short enough for a menu line: a long one keeps its start (the drive and first folder) and
 * its end (the folder the file is in and the file), with an ellipsis between.
 */
export function pathLabel(path: string): string {
  if (path.length <= PATH_LABEL_MAX) return path
  const keepEnd = Math.floor((PATH_LABEL_MAX - 1) * 0.65)
  const keepStart = PATH_LABEL_MAX - 1 - keepEnd
  return `${path.slice(0, keepStart)}…${path.slice(path.length - keepEnd)}`
}

/**
 * The right-click menu of a document tab: what to do with the tab (move, split, close the others)
 * and with its file (rename, copy, duplicate, reveal). Entries that need a file on disk are shown
 * but off for an untitled document, and "close" ones only count tabs that can be closed.
 */
export function tabMenuTemplate(input: TabMenuInput): MenuItemConstructorOptions[] {
  const { tab, tabs, words, actions } = input
  const index = tabs.findIndex((other) => other.id === tab.id)
  const file = tab.filePath
  const onDisk = !!file && input.fileExists
  const closable = (other: TabSummary): boolean => other.id !== 'home' && other.closable
  const others = tabs.filter((other) => other.id !== tab.id && closable(other))
  const right = tabs.slice(index + 1).filter(closable)
  const everything = tabs.filter(closable)
  const document = tab.kind !== 'home' && tab.kind !== 'help'

  const template: MenuItemConstructorOptions[] = [
    // where the file is, at a glance (the menu is the place people look when they ask "which one is this?")
    ...(file ? ([{ label: pathLabel(file), enabled: false }, { type: 'separator' }] as const) : []),
    { id: 'save', label: words.save, enabled: document, click: () => actions.save(tab.id) },
    { id: 'saveAs', label: words.saveAs, enabled: document, click: () => actions.saveAs(tab.id) },
    { id: 'print', label: words.print, enabled: document, click: () => actions.print(tab.id) },
    { type: 'separator' },
    { label: words.rename, enabled: !!file, click: () => actions.rename(tab.id) },
    { label: words.duplicate, enabled: onDisk, click: () => actions.duplicate(file!) },
    { type: 'separator' },
    {
      label: words.splitBeside,
      enabled: input.canDetach,
      click: () => actions.splitBeside(tab.id),
    },
    {
      label: input.labels.openInNewWindow,
      enabled: input.canDetach,
      click: () => actions.openInNewWindow(tab.id),
    },
    { type: 'separator' },
    { label: words.copyPath, enabled: !!file, click: () => actions.copyText(file!) },
    { label: words.copyName, enabled: !!file, click: () => actions.copyText(baseName(file!)) },
    { label: words.reveal, enabled: onDisk, click: () => actions.reveal(file!) },
    {
      label: words.openDefault,
      enabled: onDisk && !isProgramFile(file!),
      click: () => actions.openDefault(file!),
    },
    { type: 'separator' },
    {
      label: words.moveLeft,
      enabled: index > 1,
      click: () => actions.move(tab.id, index - 1),
    },
    {
      label: words.moveRight,
      enabled: index >= 1 && index < tabs.length - 1,
      click: () => actions.move(tab.id, index + 1),
    },
    { type: 'separator' },
    { label: input.labels.close, enabled: closable(tab), click: () => actions.closeTabs([tab.id]) },
    {
      label: words.closeOthers,
      enabled: others.length > 0,
      click: () => actions.closeTabs(others.map((other) => other.id)),
    },
    {
      label: words.closeRight,
      enabled: right.length > 0,
      click: () => actions.closeTabs(right.map((other) => other.id)),
    },
    {
      label: words.closeAll,
      enabled: everything.length > 0,
      click: () => actions.closeTabs(everything.map((other) => other.id)),
    },
    { type: 'separator' },
    { label: words.reopen, enabled: input.canReopen, click: () => actions.reopenClosed() },
  ]

  const iconForLabel = new Map<string, TabMenuIcon>([
    ...Object.entries(words).map(([key, label]) => [label, key as TabMenuIcon] as const),
    [input.labels.openInNewWindow, 'openInNewWindow'],
    [input.labels.close, 'close'],
  ])

  return template.map((item) => {
    const icon = item.label ? input.icons?.[iconForLabel.get(item.label)!] : undefined
    return icon ? { ...item, icon } : item
  })
}
