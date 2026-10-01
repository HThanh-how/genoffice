import { createI18n, type Lang, type LangDicts, type Params } from '@genoffice/i18n'

/**
 * Strings for the "Antigravity CLI" (agy) provider: Settings fields and the Home
 * chat states. Kept out of the shared strings.ts so upstream merges stay trivial.
 * `zh` defines the key set; languages without a dedicated translation reuse English.
 */
const zh = {
  agySearchNote:
    '通过 Antigravity 账号搜索网页，无需 API Key，但会消耗账号配额。使用 AI 模型中设置的路径和模型。图片搜索仍使用免费来源。',
  agyNote:
    '通过你的 Antigravity 账号在 Google 服务器上运行。每次请求都会启动 Antigravity 智能体，因此比直接调用 API 慢；适合阅读文档和图片。可通过 GenOffice 工具阅读和编辑文档。无需 API Key。',
  agyPathLabel: 'Antigravity 可执行文件',
  agyPathHint: '仅自定义安装时填写；留空会自动查找（{where}）。',
  agyPathPlaceholder: '留空自动检测（推荐）',
  agyWhereWin: 'PATH，然后是 %LOCALAPPDATA%\\agy\\bin\\agy.exe',
  agyWhereMac:
    'PATH、~/.local/bin、~/.agy/bin、/opt/homebrew/bin、/usr/local/bin，然后是登录 shell',
  agyChecking: '正在检查 Antigravity…',
  agyConnected: '已连接 · {n} 个模型',
  agyNotFound: '未连接：{error}',
  agyRecheck: '重新检查',
  agyTestFailed: '无法连接 Antigravity CLI',
  agyStarting: '正在启动 Antigravity…',
  agyStartingHint: '每条消息都会启动智能体，需要几秒钟。',
  agyContextHeader: '检索到的文档（节选）',
}

type Dict = Record<keyof typeof zh, string>

const en = {
  agySearchNote:
    'Search the web through your Antigravity account without an API key. Uses your account quota and the path and model in AI Models. Image search still uses free sources.',
  agyNote:
    "Runs on Google's servers through your Antigravity account. Each request starts the Antigravity agent, so it is slower than a direct API call; best for reading documents and images. Can read and edit documents using GenOffice tools. No API key needed.",
  agyPathLabel: 'Antigravity executable',
  agyPathHint: 'Only set this for a custom install; leave blank to auto-detect ({where}).',
  agyPathPlaceholder: 'Auto-detect (recommended)',
  agyWhereWin: 'PATH, then %LOCALAPPDATA%\\agy\\bin\\agy.exe',
  agyWhereMac:
    'PATH, ~/.local/bin, ~/.agy/bin, /opt/homebrew/bin, /usr/local/bin, then your login shell',
  agyChecking: 'Checking Antigravity…',
  agyConnected: 'Connected · {n} models',
  agyNotFound: 'Not connected: {error}',
  agyRecheck: 'Re-check',
  agyTestFailed: 'Could not reach the Antigravity CLI',
  agyStarting: 'Starting Antigravity…',
  agyStartingHint: 'Every message starts the agent, which takes a few seconds.',
  agyContextHeader: 'Retrieved documents (excerpts)',
} satisfies Dict

const vi = {
  agySearchNote:
    'Tìm web qua tài khoản Antigravity, không cần API key và dùng hạn mức của tài khoản. Dùng đường dẫn và model trong Mô hình AI. Tìm ảnh vẫn dùng nguồn miễn phí.',
  agyNote:
    'Chạy trên máy chủ của Google thông qua tài khoản Antigravity của bạn. Mỗi yêu cầu khởi động tác tử Antigravity nên chậm hơn gọi API trực tiếp; phù hợp nhất để đọc tài liệu và hình ảnh. Có thể đọc và sửa tài liệu bằng các công cụ của GenOffice. Không cần khóa API.',
  agyPathLabel: 'Tệp thực thi Antigravity',
  agyPathHint: 'Chỉ đặt mục này nếu cài đặt tùy chỉnh; để trống để tự động phát hiện ({where}).',
  agyPathPlaceholder: 'Tự động phát hiện (khuyến nghị)',
  agyWhereWin: 'PATH, sau đó %LOCALAPPDATA%\\agy\\bin\\agy.exe',
  agyWhereMac:
    'PATH, ~/.local/bin, ~/.agy/bin, /opt/homebrew/bin, /usr/local/bin, rồi đến shell đăng nhập',
  agyChecking: 'Đang kiểm tra Antigravity…',
  agyConnected: 'Đã kết nối · {n} mô hình',
  agyNotFound: 'Chưa kết nối: {error}',
  agyRecheck: 'Kiểm tra lại',
  agyTestFailed: 'Không thể kết nối Antigravity CLI',
  agyStarting: 'Đang khởi động Antigravity…',
  agyStartingHint: 'Mỗi tin nhắn khởi động tác tử nên mất vài giây.',
  agyContextHeader: 'Tài liệu đã truy xuất (trích đoạn)',
} satisfies Dict

const dicts: LangDicts<Dict> = {
  zh,
  en,
  vi,
  ja: {
    ...en,
    agySearchNote:
      'Antigravity アカウントでウェブを検索します。API キーは不要ですが、利用枠を消費します。AI モデルのパスとモデルを使用し、画像検索は無料の検索元を使用します。',
  },
  ko: {
    ...en,
    agySearchNote:
      'Antigravity 계정으로 웹을 검색합니다. API 키 없이 계정 할당량을 사용합니다. AI 모델의 경로와 모델을 사용하며 이미지 검색은 무료 소스를 사용합니다.',
  },
  'zh-TW': {
    ...en,
    agySearchNote:
      '透過 Antigravity 帳號搜尋網頁，無需 API Key，但會使用帳號額度。使用 AI 模型中的路徑和模型；圖片搜尋仍使用免費來源。',
  },
  fr: {
    ...en,
    agySearchNote:
      'Recherchez sur le web avec votre compte Antigravity, sans clé API. Utilise votre quota et le chemin et modèle des Modèles IA. La recherche d’images utilise des sources gratuites.',
  },
  de: {
    ...en,
    agySearchNote:
      'Websuche über Ihr Antigravity-Konto ohne API-Schlüssel. Nutzt Ihr Kontingent sowie Pfad und Modell aus KI-Modelle. Die Bildsuche nutzt kostenlose Quellen.',
  },
  es: {
    ...en,
    agySearchNote:
      'Busca en la web con tu cuenta Antigravity sin clave API. Usa tu cuota y la ruta y modelo de Modelos de IA. La búsqueda de imágenes usa fuentes gratuitas.',
  },
  th: {
    ...en,
    agySearchNote:
      'ค้นหาเว็บผ่านบัญชี Antigravity โดยไม่ต้องใช้ API key ใช้โควตาบัญชีและพาธกับโมเดลจากโมเดล AI การค้นหารูปภาพยังใช้แหล่งข้อมูลฟรี',
  },
  id: {
    ...en,
    agySearchNote:
      'Cari web lewat akun Antigravity tanpa kunci API. Menggunakan kuota akun serta jalur dan model dari Model AI. Pencarian gambar memakai sumber gratis.',
  },
  ru: {
    ...en,
    agySearchNote:
      'Поиск в интернете через аккаунт Antigravity без API-ключа. Использует квоту аккаунта, путь и модель из раздела моделей ИИ. Поиск изображений использует бесплатные источники.',
  },
  ar: {
    ...en,
    agySearchNote:
      'ابحث في الويب عبر حساب Antigravity دون مفتاح API. يستخدم حصة حسابك والمسار والنموذج في نماذج الذكاء الاصطناعي. يستخدم البحث عن الصور مصادر مجانية.',
  },
  pt: {
    ...en,
    agySearchNote:
      'Pesquise na web com sua conta Antigravity, sem chave API. Usa sua cota e o caminho e modelo de Modelos de IA. A busca de imagens usa fontes gratuitas.',
  },
  it: {
    ...en,
    agySearchNote:
      'Cerca sul web con il tuo account Antigravity senza chiave API. Usa la quota e il percorso e modello di Modelli IA. La ricerca immagini usa fonti gratuite.',
  },
  pl: {
    ...en,
    agySearchNote:
      'Szukaj w sieci przez konto Antigravity bez klucza API. Korzysta z limitu konta oraz ścieżki i modelu z Modeli AI. Wyszukiwanie obrazów używa darmowych źródeł.',
  },
  cs: {
    ...en,
    agySearchNote:
      'Hledejte na webu přes účet Antigravity bez klíče API. Používá kvótu účtu a cestu a model z Modelů AI. Hledání obrázků používá bezplatné zdroje.',
  },
  nl: {
    ...en,
    agySearchNote:
      'Zoek op het web via uw Antigravity-account zonder API-sleutel. Gebruikt uw quotum en het pad en model uit AI-modellen. Afbeeldingen zoeken gebruikt gratis bronnen.',
  },
  ms: {
    ...en,
    agySearchNote:
      'Cari web melalui akaun Antigravity tanpa kunci API. Menggunakan kuota akaun serta laluan dan model daripada Model AI. Carian imej menggunakan sumber percuma.',
  },
  he: {
    ...en,
    agySearchNote:
      'חיפוש באינטרנט דרך חשבון Antigravity ללא מפתח API. משתמש במכסת החשבון ובנתיב ובמודל מהגדרות מודלי AI. חיפוש תמונות משתמש במקורות חינמיים.',
  },
  hi: {
    ...en,
    agySearchNote:
      'अपने Antigravity खाते से बिना API कुंजी के वेब खोजें। खाते का कोटा और AI मॉडल का पथ व मॉडल इस्तेमाल होता है। चित्र खोज मुफ्त स्रोतों का उपयोग करती है।',
  },
}

export type AgyStringKey = keyof typeof zh

const translate = createI18n(dicts)

/** Looks up an Antigravity CLI provider string. */
export function agyString(lang: Lang, key: AgyStringKey, params?: Params): string {
  return translate(lang, key, params)
}
