export interface ClipboardHistoryLabels {
  title: string
  description: string
  clear: string
  cleared: string
  pasteMore: string
  pasteMoreEmpty: string
  pasteMoreDisabled: string
  sensitiveHint: string
}

const EN: ClipboardHistoryLabels = {
  title: 'Clipboard history',
  description:
    'On by default. Keeps up to 20 recent text and image clips on this device while the app is focused. Text that looks like a password, key or unusually long code is masked as •••••• in the list but still pastes, and is kept in memory only. Content from password managers is never saved. Turning this off clears the history.',
  clear: 'Clear history',
  cleared: 'Cleared',
  pasteMore: 'Paste more',
  pasteMoreEmpty: 'Copy some text or an image first',
  pasteMoreDisabled: 'Turn on in Settings → General → Clipboard history',
  sensitiveHint: 'Hidden: looks like a password or key. It still pastes.',
}

type ClipboardHistoryBaseLabels = Omit<
  ClipboardHistoryLabels,
  'pasteMoreEmpty' | 'pasteMoreDisabled' | 'sensitiveHint'
>
const LABELS: Record<string, ClipboardHistoryBaseLabels> = {
  en: EN,
  zh: {
    title: '剪贴板历史记录',
    description:
      '默认开启。应用处于前台时，在本机保存最近 20 条文本和图片。看起来像密码、密钥或异常长字符串的文本在列表中显示为 ••••••，仍可粘贴，且只保存在内存中。来自密码管理器的内容绝不保存。关闭后会清除此历史记录。',
    clear: '清除历史记录',
    cleared: '已清除',
    pasteMore: '粘贴更多',
  },
  'zh-TW': {
    title: '剪貼簿歷史記錄',
    description:
      '預設為開啟。應用程式位於前景時，於本機保存最近 20 則文字和圖片。看起來像密碼、金鑰或異常長字串的文字在清單中顯示為 ••••••，仍可貼上，且只保留在記憶體中。來自密碼管理器的內容絕不保存。關閉後會清除此歷史記錄。',
    clear: '清除歷史記錄',
    cleared: '已清除',
    pasteMore: '貼上更多',
  },
  vi: {
    title: 'Lịch sử clipboard',
    description:
      'Mặc định bật. Khi GenOffice đang được chọn, lưu tối đa 20 đoạn văn bản và hình ảnh gần đây trên thiết bị. Văn bản trông giống mật khẩu, khóa hoặc chuỗi dài bất thường sẽ hiện thành •••••• trong danh sách nhưng vẫn dán được, và chỉ giữ trong bộ nhớ. Nội dung từ trình quản lý mật khẩu không bao giờ được lưu. Tắt tính năng này sẽ xóa lịch sử.',
    clear: 'Xóa lịch sử',
    cleared: 'Đã xóa',
    pasteMore: 'Dán thêm',
  },
  ja: {
    title: 'クリップボード履歴',
    description:
      '初期設定ではオンです。GenOffice の使用中に最近のテキストと画像を最大 20 件、このデバイスに保存します。パスワードやキー、異常に長い文字列のように見えるテキストは一覧で •••••• と表示されますが、そのまま貼り付けられ、メモリ内にのみ保持されます。パスワードマネージャーの内容は保存されません。オフにすると履歴は消去されます。',
    clear: '履歴を消去',
    cleared: '消去しました',
    pasteMore: '別の項目を貼り付け',
  },
  ko: {
    title: '클립보드 기록',
    description:
      '기본값은 켜짐입니다. GenOffice가 활성화된 동안 최근 텍스트와 이미지를 최대 20개까지 이 기기에 저장합니다. 비밀번호, 키 또는 비정상적으로 긴 문자열처럼 보이는 텍스트는 목록에 ••••••로 표시되지만 그대로 붙여넣을 수 있으며 메모리에만 보관됩니다. 비밀번호 관리자의 내용은 저장하지 않습니다. 끄면 기록이 지워집니다.',
    clear: '기록 지우기',
    cleared: '지웠습니다',
    pasteMore: '더 붙여넣기',
  },
  fr: {
    title: 'Historique du presse-papiers',
    description:
      'Activé par défaut. Conserve sur cet appareil jusqu’à 20 textes et images récents lorsque l’application est au premier plan. Un texte qui ressemble à un mot de passe, une clé ou une chaîne anormalement longue s’affiche sous la forme •••••• dans la liste mais peut toujours être collé ; il reste uniquement en mémoire. Le contenu des gestionnaires de mots de passe n’est jamais enregistré. La désactivation efface l’historique.',
    clear: 'Effacer l’historique',
    cleared: 'Effacé',
    pasteMore: 'Coller davantage',
  },
  de: {
    title: 'Zwischenablageverlauf',
    description:
      'Standardmäßig aktiviert. Speichert bis zu 20 aktuelle Texte und Bilder auf diesem Gerät, während die App im Vordergrund ist. Text, der wie ein Passwort, ein Schlüssel oder eine ungewöhnlich lange Zeichenfolge aussieht, erscheint in der Liste als •••••• und lässt sich weiterhin einfügen; er bleibt nur im Arbeitsspeicher. Inhalte von Passwortmanagern werden nie gespeichert. Beim Deaktivieren wird der Verlauf gelöscht.',
    clear: 'Verlauf löschen',
    cleared: 'Gelöscht',
    pasteMore: 'Weitere Einträge einfügen',
  },
  es: {
    title: 'Historial del portapapeles',
    description:
      'Activado de forma predeterminada. Guarda hasta 20 textos e imágenes recientes en este dispositivo mientras la aplicación está en primer plano. El texto que parece una contraseña, una clave o una cadena inusualmente larga se muestra como •••••• en la lista, pero se puede pegar, y solo se guarda en memoria. El contenido de los gestores de contraseñas nunca se guarda. Al desactivarlo se borra el historial.',
    clear: 'Borrar historial',
    cleared: 'Borrado',
    pasteMore: 'Pegar más',
  },
  th: {
    title: 'ประวัติคลิปบอร์ด',
    description:
      'เปิดไว้เป็นค่าเริ่มต้น เก็บข้อความและรูปภาพล่าสุดสูงสุด 20 รายการบนอุปกรณ์เมื่อ GenOffice อยู่ด้านหน้า ข้อความที่ดูเหมือนรหัสผ่าน คีย์ หรือสตริงยาวผิดปกติจะแสดงเป็น •••••• ในรายการแต่ยังวางได้ และเก็บไว้ในหน่วยความจำเท่านั้น เนื้อหาจากตัวจัดการรหัสผ่านจะไม่ถูกบันทึก การปิดจะล้างประวัติ',
    clear: 'ล้างประวัติ',
    cleared: 'ล้างแล้ว',
    pasteMore: 'วางเพิ่มเติม',
  },
  id: {
    title: 'Riwayat papan klip',
    description:
      'Aktif secara default. Menyimpan hingga 20 teks dan gambar terbaru di perangkat ini selama aplikasi berada di depan. Teks yang tampak seperti kata sandi, kunci, atau string yang sangat panjang ditampilkan sebagai •••••• di daftar tetapi tetap bisa ditempel, dan hanya disimpan di memori. Konten dari pengelola kata sandi tidak pernah disimpan. Menonaktifkannya akan menghapus riwayat.',
    clear: 'Hapus riwayat',
    cleared: 'Dihapus',
    pasteMore: 'Tempel lainnya',
  },
  ru: {
    title: 'История буфера обмена',
    description:
      'По умолчанию включена. Пока приложение на переднем плане, хранит на этом устройстве до 20 последних фрагментов текста и изображений. Текст, похожий на пароль, ключ или необычно длинную строку, показывается в списке как •••••• , но по-прежнему вставляется и хранится только в памяти. Содержимое менеджеров паролей не сохраняется. При отключении история очищается.',
    clear: 'Очистить историю',
    cleared: 'Очищено',
    pasteMore: 'Вставить ещё',
  },
  ar: {
    title: 'سجل الحافظة',
    description:
      'مفعّل افتراضيًا. يحتفظ بما يصل إلى 20 نصًا وصورة حديثة على هذا الجهاز أثناء ظهور التطبيق في المقدمة. النص الذي يبدو ككلمة مرور أو مفتاح أو سلسلة طويلة بشكل غير معتاد يظهر في القائمة كـ •••••• لكنه يُلصق بشكل طبيعي ويبقى في الذاكرة فقط. لا يُحفظ محتوى مديري كلمات المرور أبدًا. يؤدي إيقافه إلى مسح السجل.',
    clear: 'مسح السجل',
    cleared: 'تم المسح',
    pasteMore: 'لصق المزيد',
  },
  pt: {
    title: 'Histórico da área de transferência',
    description:
      'Ativado por padrão. Guarda até 20 textos e imagens recentes neste dispositivo enquanto o aplicativo está em primeiro plano. Texto que parece senha, chave ou sequência anormalmente longa aparece como •••••• na lista, mas ainda pode ser colado, e fica apenas na memória. O conteúdo de gerenciadores de senhas nunca é salvo. Desativar apaga o histórico.',
    clear: 'Limpar histórico',
    cleared: 'Limpo',
    pasteMore: 'Colar mais',
  },
  it: {
    title: 'Cronologia degli appunti',
    description:
      'Attiva per impostazione predefinita. Conserva fino a 20 testi e immagini recenti su questo dispositivo mentre l’app è in primo piano. Il testo che sembra una password, una chiave o una stringa insolitamente lunga appare come •••••• nell’elenco ma si può comunque incollare e resta solo in memoria. Il contenuto dei gestori di password non viene mai salvato. Disattivarla cancella la cronologia.',
    clear: 'Cancella cronologia',
    cleared: 'Cancellata',
    pasteMore: 'Incolla altro',
  },
  pl: {
    title: 'Historia schowka',
    description:
      'Domyślnie włączona. Zapisuje na tym urządzeniu do 20 ostatnich tekstów i obrazów, gdy aplikacja jest na pierwszym planie. Tekst przypominający hasło, klucz lub nietypowo długi ciąg jest na liście wyświetlany jako •••••• , ale nadal można go wkleić, i jest przechowywany tylko w pamięci. Zawartość menedżerów haseł nigdy nie jest zapisywana. Wyłączenie czyści historię.',
    clear: 'Wyczyść historię',
    cleared: 'Wyczyszczono',
    pasteMore: 'Wklej więcej',
  },
  cs: {
    title: 'Historie schránky',
    description:
      'Ve výchozím nastavení zapnuto. Ukládá na tomto zařízení až 20 posledních textů a obrázků, když je aplikace v popředí. Text, který vypadá jako heslo, klíč nebo neobvykle dlouhý řetězec, se v seznamu zobrazí jako •••••• , ale lze jej vložit, a uchovává se jen v paměti. Obsah správců hesel se nikdy neukládá. Vypnutím se historie vymaže.',
    clear: 'Vymazat historii',
    cleared: 'Vymazáno',
    pasteMore: 'Vložit další',
  },
  nl: {
    title: 'Klembordgeschiedenis',
    description:
      'Standaard ingeschakeld. Bewaart maximaal 20 recente teksten en afbeeldingen op dit apparaat zolang de app op de voorgrond staat. Tekst die op een wachtwoord, sleutel of ongewoon lange reeks lijkt, wordt in de lijst getoond als •••••• maar kan nog steeds worden geplakt en blijft alleen in het geheugen. Inhoud van wachtwoordmanagers wordt nooit opgeslagen. Uitschakelen wist de geschiedenis.',
    clear: 'Geschiedenis wissen',
    cleared: 'Gewist',
    pasteMore: 'Meer plakken',
  },
  ms: {
    title: 'Sejarah papan klip',
    description:
      'Dihidupkan secara lalai. Menyimpan sehingga 20 teks dan imej terkini pada peranti ini semasa aplikasi berada di hadapan. Teks yang kelihatan seperti kata laluan, kunci atau rentetan yang luar biasa panjang dipaparkan sebagai •••••• dalam senarai tetapi masih boleh ditampal, dan hanya disimpan dalam memori. Kandungan daripada pengurus kata laluan tidak pernah disimpan. Mematikannya akan mengosongkan sejarah.',
    clear: 'Kosongkan sejarah',
    cleared: 'Dikosongkan',
    pasteMore: 'Tampal lagi',
  },
  he: {
    title: 'היסטוריית הלוח',
    description:
      'מופעל כברירת מחדל. שומר עד 20 קטעי טקסט ותמונות אחרונים במכשיר הזה כשהאפליקציה בחזית. טקסט שנראה כמו סיסמה, מפתח או מחרוזת ארוכה באופן חריג מוצג ברשימה כ-•••••• אך עדיין אפשר להדביק אותו, והוא נשמר בזיכרון בלבד. תוכן ממנהלי סיסמאות לא נשמר לעולם. כיבוי מנקה את ההיסטוריה.',
    clear: 'ניקוי ההיסטוריה',
    cleared: 'נמחקה',
    pasteMore: 'הדבק עוד',
  },
  hi: {
    title: 'क्लिपबोर्ड इतिहास',
    description:
      'डिफ़ॉल्ट रूप से चालू। ऐप सामने रहने के दौरान यह इस डिवाइस पर हाल के 20 तक टेक्स्ट और चित्र सहेजता है। पासवर्ड, कुंजी या असामान्य रूप से लंबे स्ट्रिंग जैसा दिखने वाला टेक्स्ट सूची में •••••• के रूप में दिखता है, फिर भी चिपकाया जा सकता है, और केवल मेमोरी में रहता है। पासवर्ड मैनेजर की सामग्री कभी सहेजी नहीं जाती। बंद करने पर इतिहास मिट जाता है।',
    clear: 'इतिहास मिटाएँ',
    cleared: 'मिटा दिया',
    pasteMore: 'और चिपकाएँ',
  },
}

const PASTE_MORE_EMPTY: Record<string, string> = {
  en: 'Copy some text or an image first',
  zh: '请先复制一些文本',
  'zh-TW': '請先複製一些文字',
  vi: 'Hãy sao chép văn bản trước',
  ja: '先にテキストをコピーしてください',
  ko: '먼저 텍스트를 복사하세요',
  fr: 'Copiez d’abord du texte',
  de: 'Kopiere zuerst einen Text',
  es: 'Copia texto primero',
  th: 'คัดลอกข้อความก่อน',
  id: 'Salin teks terlebih dahulu',
  ru: 'Сначала скопируйте текст',
  ar: 'انسخ نصًا أولًا',
  pt: 'Copie algum texto primeiro',
  it: 'Copia prima del testo',
  pl: 'Najpierw skopiuj tekst',
  cs: 'Nejprve zkopírujte text',
  nl: 'Kopieer eerst tekst',
  ms: 'Salin teks dahulu',
  he: 'יש להעתיק טקסט תחילה',
  hi: 'पहले कुछ टेक्स्ट कॉपी करें',
}

const NORMAL_PASTE_NOTE: Record<string, string> = {
  en: 'Regular Paste still uses the current clipboard and keeps rich formatting.',
  zh: '普通“粘贴”仍使用当前剪贴板并保留富文本格式。',
  'zh-TW': '一般「貼上」仍使用目前的剪貼簿並保留豐富格式。',
  vi: 'Lệnh Dán thông thường vẫn dùng clipboard hiện tại và giữ nguyên định dạng.',
  ja: '通常の貼り付けは引き続き現在のクリップボードを使い、書式も保持します。',
  ko: '일반 붙여넣기는 계속 현재 클립보드를 사용하며 서식을 유지합니다.',
  fr: 'Le collage habituel utilise toujours le presse-papiers actuel et conserve la mise en forme.',
  de: 'Normales Einfügen verwendet weiterhin den aktuellen Zwischenablageinhalt samt Formatierung.',
  es: 'Pegar normalmente sigue usando el portapapeles actual y conserva el formato.',
  th: 'การวางปกติยังคงใช้คลิปบอร์ดปัจจุบันและคงรูปแบบข้อความไว้',
  id: 'Tempel biasa tetap menggunakan papan klip saat ini dan mempertahankan pemformatan.',
  ru: 'Обычная вставка по-прежнему использует текущее содержимое буфера и сохраняет форматирование.',
  ar: 'يظل اللصق العادي يستخدم محتوى الحافظة الحالي ويحافظ على التنسيق.',
  pt: 'A colagem normal continua usando a área de transferência atual e mantém a formatação.',
  it: 'Il normale comando Incolla continua a usare gli appunti correnti e mantiene la formattazione.',
  pl: 'Zwykłe wklejanie nadal używa bieżącej zawartości schowka i zachowuje formatowanie.',
  cs: 'Běžné vložení stále používá aktuální schránku a zachovává formátování.',
  nl: 'Normaal plakken gebruikt nog steeds de huidige klembordinhoud en behoudt de opmaak.',
  ms: 'Tampal biasa terus menggunakan papan klip semasa dan mengekalkan pemformatan.',
  he: 'ההדבקה הרגילה ממשיכה להשתמש בלוח הנוכחי ולשמור על העיצוב.',
  hi: 'सामान्य पेस्ट मौजूदा क्लिपबोर्ड का उपयोग करता रहेगा और फ़ॉर्मैटिंग बनाए रखेगा।',
}

const PASTE_MORE_DISABLED: Record<string, string> = {
  vi: 'Bật trong Cài đặt → Chung → Lịch sử clipboard',
  zh: '请在 设置 → 通用 → 剪贴板历史记录 中开启',
  'zh-TW': '請在 設定 → 一般 → 剪貼簿歷史記錄 中開啟',
}

const SENSITIVE_HINT: Record<string, string> = {
  vi: 'Đã ẩn: trông giống mật khẩu hoặc khóa. Vẫn dán được.',
  zh: '已隐藏：看起来像密码或密钥，仍可粘贴。',
  'zh-TW': '已隱藏：看起來像密碼或金鑰，仍可貼上。',
}

export function clipboardHistoryLabels(lang: string): ClipboardHistoryLabels {
  const labels = LABELS[lang] ?? EN
  return {
    ...labels,
    description: `${labels.description} ${NORMAL_PASTE_NOTE[lang] ?? NORMAL_PASTE_NOTE.en}`,
    pasteMoreEmpty: PASTE_MORE_EMPTY[lang] ?? EN.pasteMoreEmpty,
    pasteMoreDisabled: PASTE_MORE_DISABLED[lang] ?? EN.pasteMoreDisabled,
    sensitiveHint: SENSITIVE_HINT[lang] ?? EN.sensitiveHint,
  }
}
