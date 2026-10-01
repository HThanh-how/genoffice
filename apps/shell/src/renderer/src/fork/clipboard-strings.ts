import { createI18n, type Lang, type LangDicts, type Params } from '@genoffice/i18n'

/**
 * Strings for the clipboard suggestion chip and its Settings toggle. Kept out of
 * the shared strings.ts so upstream merges stay trivial. `zh` defines the key set;
 * every other language below is type-checked against it.
 */
const zh = {
  clipSetting: '为我复制的内容推荐操作',
  clipSettingDesc:
    '默认关闭。开启后，GenOffice 在前台时会检查你刚复制的文字，并在主页建议一个 AI 操作。这一切都在本机完成；在你点击建议之前，不会向任何 AI 发送内容。密码、密钥、银行卡号以及来自密码管理器的内容会被跳过，剪贴板内容不会被保存。',
  clipRegion: '剪贴板建议',
  clipHeader: '来自你的剪贴板',
  clipDismiss: '忽略',
  clipTurnOff: '关闭建议',
  clipTruncated: '仅使用前 20,000 个字符。',
  clipActSummarize: '总结',
  clipActTranslate: '翻译成{lang}',
  clipActRewrite: '改写',
  clipActAsk: '问 AI',
  clipActFindRelated: '查找相关文件',
  clipActAnalyze: '分析这些数据',
  clipActToSheet: '转为表格',
  clipActExplainCode: '解释这段代码',
  clipActOrganize: '整理联系信息',
}

type Dict = Record<keyof typeof zh, string>

const en = {
  clipSetting: 'Suggest actions for what I copy',
  clipSettingDesc:
    'Off by default. When on and GenOffice is in focus, it checks your clipboard for text you just copied and suggests an AI action on the Home screen. This happens on your device; nothing is sent to any AI until you click a suggestion. Passwords, keys, card numbers and content from password managers are skipped, and clipboard content is never saved.',
  clipRegion: 'Clipboard suggestion',
  clipHeader: 'From your clipboard',
  clipDismiss: 'Dismiss',
  clipTurnOff: 'Turn off suggestions',
  clipTruncated: 'Only the first 20,000 characters will be used.',
  clipActSummarize: 'Summarize',
  clipActTranslate: 'Translate to {lang}',
  clipActRewrite: 'Rewrite',
  clipActAsk: 'Ask AI',
  clipActFindRelated: 'Find related files',
  clipActAnalyze: 'Analyze this data',
  clipActToSheet: 'Turn into a sheet',
  clipActExplainCode: 'Explain this code',
  clipActOrganize: 'Organize contact details',
} satisfies Dict

const vi = {
  clipSetting: 'Gợi ý hành động cho nội dung tôi sao chép',
  clipSettingDesc:
    'Mặc định tắt. Khi bật và GenOffice đang được chọn, ứng dụng sẽ kiểm tra clipboard để tìm nội dung bạn vừa sao chép và gợi ý một thao tác AI trên màn hình Chính. Việc này diễn ra ngay trên máy của bạn; không có gì được gửi tới AI cho đến khi bạn bấm vào một gợi ý. Mật khẩu, khóa API, số thẻ và nội dung từ trình quản lý mật khẩu sẽ bị bỏ qua, và nội dung clipboard không bao giờ được lưu lại.',
  clipRegion: 'Gợi ý từ clipboard',
  clipHeader: 'Từ clipboard của bạn',
  clipDismiss: 'Bỏ qua',
  clipTurnOff: 'Tắt gợi ý',
  clipTruncated: 'Chỉ dùng 20.000 ký tự đầu tiên.',
  clipActSummarize: 'Tóm tắt',
  clipActTranslate: 'Dịch sang {lang}',
  clipActRewrite: 'Viết lại',
  clipActAsk: 'Hỏi AI',
  clipActFindRelated: 'Tìm tệp liên quan',
  clipActAnalyze: 'Phân tích dữ liệu này',
  clipActToSheet: 'Chuyển thành bảng tính',
  clipActExplainCode: 'Giải thích đoạn mã này',
  clipActOrganize: 'Sắp xếp thông tin liên hệ',
} satisfies Dict

const ja = {
  clipSetting: 'コピーした内容に対する操作を提案',
  clipSettingDesc:
    '初期設定ではオフです。オンにすると、GenOffice を操作中にコピーしたテキストを確認し、ホーム画面で AI の操作を提案します。処理はすべてお使いのデバイス上で行われ、提案をクリックするまで AI には何も送信されません。パスワード、キー、カード番号、パスワードマネージャーの内容は対象外で、クリップボードの内容が保存されることもありません。',
  clipRegion: 'クリップボードの提案',
  clipHeader: 'クリップボードから',
  clipDismiss: '閉じる',
  clipTurnOff: '提案をオフにする',
  clipTruncated: '先頭の 20,000 文字のみ使用します。',
  clipActSummarize: '要約',
  clipActTranslate: '{lang}に翻訳',
  clipActRewrite: '書き直し',
  clipActAsk: 'AI に質問',
  clipActFindRelated: '関連ファイルを探す',
  clipActAnalyze: 'このデータを分析',
  clipActToSheet: 'シートにする',
  clipActExplainCode: 'このコードを説明',
  clipActOrganize: '連絡先を整理',
} satisfies Dict

const ko = {
  clipSetting: '복사한 내용에 대한 작업 제안',
  clipSettingDesc:
    '기본값은 꺼짐입니다. 켜면 GenOffice가 활성화된 동안 방금 복사한 텍스트를 확인하고 홈 화면에서 AI 작업을 제안합니다. 모든 과정은 기기에서 이루어지며, 제안을 클릭하기 전에는 어떤 AI에도 전송되지 않습니다. 비밀번호, 키, 카드 번호, 비밀번호 관리자의 내용은 건너뛰며 클립보드 내용은 저장되지 않습니다.',
  clipRegion: '클립보드 제안',
  clipHeader: '클립보드에서',
  clipDismiss: '닫기',
  clipTurnOff: '제안 끄기',
  clipTruncated: '처음 20,000자만 사용됩니다.',
  clipActSummarize: '요약',
  clipActTranslate: '{lang}(으)로 번역',
  clipActRewrite: '다시 쓰기',
  clipActAsk: 'AI에게 질문',
  clipActFindRelated: '관련 파일 찾기',
  clipActAnalyze: '이 데이터 분석',
  clipActToSheet: '시트로 만들기',
  clipActExplainCode: '이 코드 설명',
  clipActOrganize: '연락처 정리',
} satisfies Dict

const fr = {
  clipSetting: 'Suggérer des actions pour ce que je copie',
  clipSettingDesc:
    "Désactivé par défaut. Lorsqu'il est activé et que GenOffice est au premier plan, il examine le texte que vous venez de copier et propose une action IA sur l'écran d'accueil. Tout se passe sur votre appareil ; rien n'est envoyé à une IA avant que vous cliquiez sur une suggestion. Les mots de passe, clés, numéros de carte et contenus de gestionnaires de mots de passe sont ignorés, et le contenu du presse-papiers n'est jamais enregistré.",
  clipRegion: 'Suggestion du presse-papiers',
  clipHeader: 'Depuis votre presse-papiers',
  clipDismiss: 'Ignorer',
  clipTurnOff: 'Désactiver les suggestions',
  clipTruncated: 'Seuls les 20 000 premiers caractères seront utilisés.',
  clipActSummarize: 'Résumer',
  clipActTranslate: 'Traduire en {lang}',
  clipActRewrite: 'Reformuler',
  clipActAsk: "Demander à l'IA",
  clipActFindRelated: 'Trouver des fichiers liés',
  clipActAnalyze: 'Analyser ces données',
  clipActToSheet: 'Convertir en feuille',
  clipActExplainCode: 'Expliquer ce code',
  clipActOrganize: 'Organiser les coordonnées',
} satisfies Dict

const de = {
  clipSetting: 'Aktionen für kopierte Inhalte vorschlagen',
  clipSettingDesc:
    'Standardmäßig aus. Wenn aktiviert und GenOffice im Vordergrund ist, prüft die App den soeben kopierten Text und schlägt auf dem Startbildschirm eine KI-Aktion vor. Das geschieht auf Ihrem Gerät; erst wenn Sie auf einen Vorschlag klicken, wird etwas an eine KI gesendet. Passwörter, Schlüssel, Kartennummern und Inhalte von Passwortmanagern werden übersprungen, und Inhalte der Zwischenablage werden nie gespeichert.',
  clipRegion: 'Vorschlag aus der Zwischenablage',
  clipHeader: 'Aus Ihrer Zwischenablage',
  clipDismiss: 'Schließen',
  clipTurnOff: 'Vorschläge ausschalten',
  clipTruncated: 'Es werden nur die ersten 20.000 Zeichen verwendet.',
  clipActSummarize: 'Zusammenfassen',
  clipActTranslate: 'Ins {lang} übersetzen',
  clipActRewrite: 'Umformulieren',
  clipActAsk: 'KI fragen',
  clipActFindRelated: 'Verwandte Dateien finden',
  clipActAnalyze: 'Diese Daten analysieren',
  clipActToSheet: 'In Tabelle umwandeln',
  clipActExplainCode: 'Diesen Code erklären',
  clipActOrganize: 'Kontaktdaten ordnen',
} satisfies Dict

const es = {
  clipSetting: 'Sugerir acciones para lo que copio',
  clipSettingDesc:
    'Desactivado de forma predeterminada. Si lo activas y GenOffice está en primer plano, revisa el texto que acabas de copiar y sugiere una acción de IA en la pantalla de inicio. Todo ocurre en tu dispositivo; no se envía nada a ninguna IA hasta que hagas clic en una sugerencia. Se omiten contraseñas, claves, números de tarjeta y contenido de gestores de contraseñas, y el contenido del portapapeles nunca se guarda.',
  clipRegion: 'Sugerencia del portapapeles',
  clipHeader: 'De tu portapapeles',
  clipDismiss: 'Descartar',
  clipTurnOff: 'Desactivar sugerencias',
  clipTruncated: 'Solo se usarán los primeros 20 000 caracteres.',
  clipActSummarize: 'Resumir',
  clipActTranslate: 'Traducir al {lang}',
  clipActRewrite: 'Reescribir',
  clipActAsk: 'Preguntar a la IA',
  clipActFindRelated: 'Buscar archivos relacionados',
  clipActAnalyze: 'Analizar estos datos',
  clipActToSheet: 'Convertir en hoja de cálculo',
  clipActExplainCode: 'Explicar este código',
  clipActOrganize: 'Organizar datos de contacto',
} satisfies Dict

const th = {
  clipSetting: 'แนะนำการทำงานสำหรับสิ่งที่ฉันคัดลอก',
  clipSettingDesc:
    'ปิดไว้เป็นค่าเริ่มต้น เมื่อเปิดและ GenOffice กำลังใช้งานอยู่ แอปจะตรวจสอบข้อความที่คุณเพิ่งคัดลอกและแนะนำการทำงานของ AI บนหน้าหลัก ทั้งหมดเกิดขึ้นบนอุปกรณ์ของคุณ และจะไม่ส่งสิ่งใดไปยัง AI จนกว่าคุณจะคลิกคำแนะนำ รหัสผ่าน คีย์ หมายเลขบัตร และเนื้อหาจากตัวจัดการรหัสผ่านจะถูกข้าม และเนื้อหาคลิปบอร์ดจะไม่ถูกบันทึก',
  clipRegion: 'คำแนะนำจากคลิปบอร์ด',
  clipHeader: 'จากคลิปบอร์ดของคุณ',
  clipDismiss: 'ปิด',
  clipTurnOff: 'ปิดคำแนะนำ',
  clipTruncated: 'จะใช้เพียง 20,000 ตัวอักษรแรก',
  clipActSummarize: 'สรุป',
  clipActTranslate: 'แปลเป็น{lang}',
  clipActRewrite: 'เขียนใหม่',
  clipActAsk: 'ถาม AI',
  clipActFindRelated: 'ค้นหาไฟล์ที่เกี่ยวข้อง',
  clipActAnalyze: 'วิเคราะห์ข้อมูลนี้',
  clipActToSheet: 'แปลงเป็นชีต',
  clipActExplainCode: 'อธิบายโค้ดนี้',
  clipActOrganize: 'จัดระเบียบข้อมูลติดต่อ',
} satisfies Dict

const id = {
  clipSetting: 'Sarankan tindakan untuk yang saya salin',
  clipSettingDesc:
    'Nonaktif secara default. Saat aktif dan GenOffice sedang dibuka, aplikasi memeriksa teks yang baru Anda salin dan menyarankan tindakan AI di layar Beranda. Semua terjadi di perangkat Anda; tidak ada yang dikirim ke AI sampai Anda mengeklik saran. Kata sandi, kunci, nomor kartu, dan konten dari pengelola kata sandi dilewati, dan isi papan klip tidak pernah disimpan.',
  clipRegion: 'Saran papan klip',
  clipHeader: 'Dari papan klip Anda',
  clipDismiss: 'Tutup',
  clipTurnOff: 'Matikan saran',
  clipTruncated: 'Hanya 20.000 karakter pertama yang akan digunakan.',
  clipActSummarize: 'Ringkas',
  clipActTranslate: 'Terjemahkan ke {lang}',
  clipActRewrite: 'Tulis ulang',
  clipActAsk: 'Tanya AI',
  clipActFindRelated: 'Cari file terkait',
  clipActAnalyze: 'Analisis data ini',
  clipActToSheet: 'Ubah menjadi lembar kerja',
  clipActExplainCode: 'Jelaskan kode ini',
  clipActOrganize: 'Rapikan detail kontak',
} satisfies Dict

const ru = {
  clipSetting: 'Предлагать действия для скопированного',
  clipSettingDesc:
    'По умолчанию выключено. Если включить и GenOffice находится в фокусе, приложение проверит только что скопированный текст и предложит действие ИИ на главном экране. Всё происходит на вашем устройстве: ничего не отправляется в ИИ, пока вы не нажмёте на подсказку. Пароли, ключи, номера карт и содержимое менеджеров паролей пропускаются, а содержимое буфера обмена никогда не сохраняется.',
  clipRegion: 'Подсказка из буфера обмена',
  clipHeader: 'Из вашего буфера обмена',
  clipDismiss: 'Скрыть',
  clipTurnOff: 'Отключить подсказки',
  clipTruncated: 'Будут использованы только первые 20 000 символов.',
  clipActSummarize: 'Кратко изложить',
  clipActTranslate: 'Перевести на {lang}',
  clipActRewrite: 'Переписать',
  clipActAsk: 'Спросить ИИ',
  clipActFindRelated: 'Найти связанные файлы',
  clipActAnalyze: 'Проанализировать данные',
  clipActToSheet: 'Превратить в таблицу',
  clipActExplainCode: 'Объяснить код',
  clipActOrganize: 'Упорядочить контакты',
} satisfies Dict

const ar = {
  clipSetting: 'اقتراح إجراءات لما أنسخه',
  clipSettingDesc:
    'متوقف افتراضيًا. عند تفعيله وعندما يكون GenOffice في المقدمة، يفحص النص الذي نسخته للتو ويقترح إجراءً بالذكاء الاصطناعي في الشاشة الرئيسية. يتم ذلك على جهازك؛ ولا يُرسل أي شيء إلى أي ذكاء اصطناعي حتى تنقر على اقتراح. تُتجاهل كلمات المرور والمفاتيح وأرقام البطاقات ومحتوى مديري كلمات المرور، ولا يُحفظ محتوى الحافظة أبدًا.',
  clipRegion: 'اقتراح من الحافظة',
  clipHeader: 'من الحافظة لديك',
  clipDismiss: 'تجاهل',
  clipTurnOff: 'إيقاف الاقتراحات',
  clipTruncated: 'سيتم استخدام أول 20,000 حرف فقط.',
  clipActSummarize: 'تلخيص',
  clipActTranslate: 'الترجمة إلى {lang}',
  clipActRewrite: 'إعادة صياغة',
  clipActAsk: 'اسأل الذكاء الاصطناعي',
  clipActFindRelated: 'العثور على ملفات ذات صلة',
  clipActAnalyze: 'تحليل هذه البيانات',
  clipActToSheet: 'تحويل إلى جدول',
  clipActExplainCode: 'شرح هذا الكود',
  clipActOrganize: 'تنظيم بيانات الاتصال',
} satisfies Dict

const pt = {
  clipSetting: 'Sugerir ações para o que eu copio',
  clipSettingDesc:
    'Desativado por padrão. Quando ativado e com o GenOffice em foco, ele verifica o texto que você acabou de copiar e sugere uma ação de IA na tela inicial. Tudo acontece no seu dispositivo; nada é enviado a nenhuma IA até você clicar em uma sugestão. Senhas, chaves, números de cartão e conteúdo de gerenciadores de senhas são ignorados, e o conteúdo da área de transferência nunca é salvo.',
  clipRegion: 'Sugestão da área de transferência',
  clipHeader: 'Da sua área de transferência',
  clipDismiss: 'Dispensar',
  clipTurnOff: 'Desativar sugestões',
  clipTruncated: 'Somente os primeiros 20.000 caracteres serão usados.',
  clipActSummarize: 'Resumir',
  clipActTranslate: 'Traduzir para {lang}',
  clipActRewrite: 'Reescrever',
  clipActAsk: 'Perguntar à IA',
  clipActFindRelated: 'Encontrar arquivos relacionados',
  clipActAnalyze: 'Analisar estes dados',
  clipActToSheet: 'Transformar em planilha',
  clipActExplainCode: 'Explicar este código',
  clipActOrganize: 'Organizar dados de contato',
} satisfies Dict

const it = {
  clipSetting: 'Suggerisci azioni per ciò che copio',
  clipSettingDesc:
    "Disattivato per impostazione predefinita. Se attivato e con GenOffice in primo piano, controlla il testo appena copiato e suggerisce un'azione IA nella schermata iniziale. Tutto avviene sul tuo dispositivo; non viene inviato nulla a nessuna IA finché non fai clic su un suggerimento. Password, chiavi, numeri di carta e contenuti dei gestori di password vengono ignorati e il contenuto degli appunti non viene mai salvato.",
  clipRegion: 'Suggerimento dagli appunti',
  clipHeader: 'Dai tuoi appunti',
  clipDismiss: 'Ignora',
  clipTurnOff: 'Disattiva i suggerimenti',
  clipTruncated: 'Verranno usati solo i primi 20.000 caratteri.',
  clipActSummarize: 'Riassumi',
  clipActTranslate: 'Traduci in {lang}',
  clipActRewrite: 'Riscrivi',
  clipActAsk: "Chiedi all'IA",
  clipActFindRelated: 'Trova file correlati',
  clipActAnalyze: 'Analizza questi dati',
  clipActToSheet: 'Trasforma in foglio',
  clipActExplainCode: 'Spiega questo codice',
  clipActOrganize: 'Organizza i dati di contatto',
} satisfies Dict

const pl = {
  clipSetting: 'Podpowiadaj działania dla skopiowanych treści',
  clipSettingDesc:
    'Domyślnie wyłączone. Po włączeniu, gdy GenOffice jest aktywny, aplikacja sprawdza świeżo skopiowany tekst i proponuje akcję AI na ekranie głównym. Wszystko dzieje się na Twoim urządzeniu; nic nie trafia do żadnej AI, dopóki nie klikniesz podpowiedzi. Hasła, klucze, numery kart i treści z menedżerów haseł są pomijane, a zawartość schowka nigdy nie jest zapisywana.',
  clipRegion: 'Podpowiedź ze schowka',
  clipHeader: 'Z Twojego schowka',
  clipDismiss: 'Odrzuć',
  clipTurnOff: 'Wyłącz podpowiedzi',
  clipTruncated: 'Zostanie użyte tylko pierwsze 20 000 znaków.',
  clipActSummarize: 'Podsumuj',
  clipActTranslate: 'Przetłumacz na {lang}',
  clipActRewrite: 'Przepisz',
  clipActAsk: 'Zapytaj AI',
  clipActFindRelated: 'Znajdź powiązane pliki',
  clipActAnalyze: 'Przeanalizuj te dane',
  clipActToSheet: 'Zamień na arkusz',
  clipActExplainCode: 'Wyjaśnij ten kod',
  clipActOrganize: 'Uporządkuj dane kontaktowe',
} satisfies Dict

const cs = {
  clipSetting: 'Navrhovat akce pro zkopírovaný obsah',
  clipSettingDesc:
    'Ve výchozím stavu vypnuto. Po zapnutí a když je GenOffice aktivní, aplikace zkontroluje právě zkopírovaný text a na domovské obrazovce navrhne akci AI. Vše probíhá ve vašem zařízení; dokud na návrh neklepnete, nic se do žádné AI neodešle. Hesla, klíče, čísla karet a obsah ze správců hesel se přeskakují a obsah schránky se nikdy neukládá.',
  clipRegion: 'Návrh ze schránky',
  clipHeader: 'Z vaší schránky',
  clipDismiss: 'Zavřít',
  clipTurnOff: 'Vypnout návrhy',
  clipTruncated: 'Použije se jen prvních 20 000 znaků.',
  clipActSummarize: 'Shrnout',
  clipActTranslate: 'Přeložit do jazyka {lang}',
  clipActRewrite: 'Přepsat',
  clipActAsk: 'Zeptat se AI',
  clipActFindRelated: 'Najít související soubory',
  clipActAnalyze: 'Analyzovat tato data',
  clipActToSheet: 'Převést na tabulku',
  clipActExplainCode: 'Vysvětlit tento kód',
  clipActOrganize: 'Uspořádat kontaktní údaje',
} satisfies Dict

const nl = {
  clipSetting: 'Acties voorstellen voor wat ik kopieer',
  clipSettingDesc:
    'Standaard uit. Als dit aan staat en GenOffice actief is, bekijkt de app de tekst die je net hebt gekopieerd en stelt ze op het startscherm een AI-actie voor. Alles gebeurt op je apparaat; er wordt niets naar een AI gestuurd totdat je op een suggestie klikt. Wachtwoorden, sleutels, kaartnummers en inhoud van wachtwoordbeheerders worden overgeslagen en de inhoud van het klembord wordt nooit opgeslagen.',
  clipRegion: 'Suggestie van het klembord',
  clipHeader: 'Van je klembord',
  clipDismiss: 'Sluiten',
  clipTurnOff: 'Suggesties uitzetten',
  clipTruncated: 'Alleen de eerste 20.000 tekens worden gebruikt.',
  clipActSummarize: 'Samenvatten',
  clipActTranslate: 'Vertalen naar {lang}',
  clipActRewrite: 'Herschrijven',
  clipActAsk: 'Vraag het de AI',
  clipActFindRelated: 'Gerelateerde bestanden zoeken',
  clipActAnalyze: 'Deze gegevens analyseren',
  clipActToSheet: 'Omzetten naar spreadsheet',
  clipActExplainCode: 'Deze code uitleggen',
  clipActOrganize: 'Contactgegevens ordenen',
} satisfies Dict

const ms = {
  clipSetting: 'Cadangkan tindakan untuk apa yang saya salin',
  clipSettingDesc:
    'Dimatikan secara lalai. Apabila dihidupkan dan GenOffice sedang digunakan, ia menyemak teks yang baru anda salin dan mencadangkan tindakan AI pada skrin Utama. Semuanya berlaku pada peranti anda; tiada apa dihantar kepada mana-mana AI sehingga anda mengklik cadangan. Kata laluan, kunci, nombor kad dan kandungan daripada pengurus kata laluan dilangkau, dan kandungan papan keratan tidak pernah disimpan.',
  clipRegion: 'Cadangan papan keratan',
  clipHeader: 'Daripada papan keratan anda',
  clipDismiss: 'Tutup',
  clipTurnOff: 'Matikan cadangan',
  clipTruncated: 'Hanya 20,000 aksara pertama akan digunakan.',
  clipActSummarize: 'Ringkaskan',
  clipActTranslate: 'Terjemah ke {lang}',
  clipActRewrite: 'Tulis semula',
  clipActAsk: 'Tanya AI',
  clipActFindRelated: 'Cari fail berkaitan',
  clipActAnalyze: 'Analisis data ini',
  clipActToSheet: 'Tukar kepada lembaran',
  clipActExplainCode: 'Terangkan kod ini',
  clipActOrganize: 'Susun butiran hubungan',
} satisfies Dict

const he = {
  clipSetting: 'הצעת פעולות עבור מה שהעתקתי',
  clipSettingDesc:
    'כבוי כברירת מחדל. כשהאפשרות מופעלת ו-GenOffice בפוקוס, האפליקציה בודקת את הטקסט שהעתקת זה עתה ומציעה פעולת AI במסך הבית. הכול קורה במכשיר שלך; שום דבר לא נשלח לשום AI עד שתלחץ על הצעה. סיסמאות, מפתחות, מספרי כרטיס ותוכן ממנהלי סיסמאות מדולגים, ותוכן הלוח אינו נשמר לעולם.',
  clipRegion: 'הצעה מהלוח',
  clipHeader: 'מהלוח שלך',
  clipDismiss: 'סגירה',
  clipTurnOff: 'כיבוי ההצעות',
  clipTruncated: 'ייעשה שימוש ב-20,000 התווים הראשונים בלבד.',
  clipActSummarize: 'סיכום',
  clipActTranslate: 'תרגום ל{lang}',
  clipActRewrite: 'ניסוח מחדש',
  clipActAsk: 'שאל את ה-AI',
  clipActFindRelated: 'מצא קבצים קשורים',
  clipActAnalyze: 'נתח את הנתונים',
  clipActToSheet: 'הפוך לגיליון',
  clipActExplainCode: 'הסבר את הקוד',
  clipActOrganize: 'ארגן פרטי קשר',
} satisfies Dict

const hi = {
  clipSetting: 'मैं जो कॉपी करूँ उसके लिए कार्रवाई सुझाएँ',
  clipSettingDesc:
    'डिफ़ॉल्ट रूप से बंद। चालू होने पर और GenOffice के सक्रिय रहते, यह अभी कॉपी किया गया टेक्स्ट जाँचता है और होम स्क्रीन पर एक AI कार्रवाई सुझाता है। यह सब आपके डिवाइस पर होता है; जब तक आप किसी सुझाव पर क्लिक नहीं करते, कुछ भी किसी AI को नहीं भेजा जाता। पासवर्ड, कुंजियाँ, कार्ड नंबर और पासवर्ड मैनेजर की सामग्री छोड़ दी जाती है, और क्लिपबोर्ड की सामग्री कभी सहेजी नहीं जाती।',
  clipRegion: 'क्लिपबोर्ड सुझाव',
  clipHeader: 'आपके क्लिपबोर्ड से',
  clipDismiss: 'हटाएँ',
  clipTurnOff: 'सुझाव बंद करें',
  clipTruncated: 'केवल पहले 20,000 अक्षर उपयोग किए जाएँगे।',
  clipActSummarize: 'सारांश',
  clipActTranslate: '{lang} में अनुवाद करें',
  clipActRewrite: 'फिर से लिखें',
  clipActAsk: 'AI से पूछें',
  clipActFindRelated: 'संबंधित फ़ाइलें खोजें',
  clipActAnalyze: 'इस डेटा का विश्लेषण करें',
  clipActToSheet: 'शीट में बदलें',
  clipActExplainCode: 'इस कोड को समझाएँ',
  clipActOrganize: 'संपर्क विवरण व्यवस्थित करें',
} satisfies Dict

const zhTW = {
  clipSetting: '為我複製的內容建議動作',
  clipSettingDesc:
    '預設關閉。開啟後，GenOffice 在前景時會檢查你剛複製的文字，並在主畫面建議一個 AI 動作。這一切都在本機完成；在你點選建議之前，不會向任何 AI 傳送內容。密碼、金鑰、信用卡號以及來自密碼管理員的內容會被略過，剪貼簿內容不會被儲存。',
  clipRegion: '剪貼簿建議',
  clipHeader: '來自你的剪貼簿',
  clipDismiss: '略過',
  clipTurnOff: '關閉建議',
  clipTruncated: '僅使用前 20,000 個字元。',
  clipActSummarize: '摘要',
  clipActTranslate: '翻譯成{lang}',
  clipActRewrite: '改寫',
  clipActAsk: '詢問 AI',
  clipActFindRelated: '尋找相關檔案',
  clipActAnalyze: '分析這些資料',
  clipActToSheet: '轉為試算表',
  clipActExplainCode: '解釋這段程式碼',
  clipActOrganize: '整理聯絡資訊',
} satisfies Dict

const dicts: LangDicts<Dict> = {
  zh,
  en,
  vi,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  cs,
  nl,
  ms,
  he,
  hi,
  'zh-TW': zhTW,
}

export type ClipboardStringKey = keyof typeof zh

const translate = createI18n(dicts)

/** Looks up a clipboard suggestion string. */
export function clipboardString(lang: Lang, key: ClipboardStringKey, params?: Params): string {
  return translate(lang, key, params)
}
