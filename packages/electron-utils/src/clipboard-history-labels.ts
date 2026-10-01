export interface ClipboardHistoryLabels {
  title: string
  description: string
  clear: string
  cleared: string
  pasteMore: string
  pasteMoreEmpty: string
}

const EN: ClipboardHistoryLabels = {
  title: 'Clipboard history',
  description:
    'Off by default. When on, GenOffice keeps up to 20 recent text clips on this device while the app is focused. Images and rich formatting are not saved. Passwords, keys, card numbers and password-manager content are skipped. Turning this off clears the history.',
  clear: 'Clear history',
  cleared: 'Cleared',
  pasteMore: 'Paste more',
  pasteMoreEmpty: 'Copy some text first',
}

type ClipboardHistoryBaseLabels = Omit<ClipboardHistoryLabels, 'pasteMoreEmpty'>
const LABELS: Record<string, ClipboardHistoryBaseLabels> = {
  en: EN,
  zh: {
    title: '剪贴板历史记录',
    description:
      '默认关闭。开启后，GenOffice 仅在应用处于前台时在本机保存最近 20 条文本。不保存图片和富文本格式。密码、密钥、银行卡号和密码管理器内容会被跳过。关闭后会清除此历史记录。',
    clear: '清除历史记录',
    cleared: '已清除',
    pasteMore: '粘贴更多',
  },
  'zh-TW': {
    title: '剪貼簿歷史記錄',
    description:
      '預設為關閉。開啟後，GenOffice 僅在應用程式位於前景時於本機保存最近 20 則文字。不保存圖片和豐富格式。密碼、金鑰、信用卡號和密碼管理器內容會被略過。關閉後會清除此歷史記錄。',
    clear: '清除歷史記錄',
    cleared: '已清除',
    pasteMore: '貼上更多',
  },
  vi: {
    title: 'Lịch sử clipboard',
    description:
      'Mặc định tắt. Khi bật, GenOffice lưu tối đa 20 đoạn văn bản gần đây trên thiết bị khi GenOffice đang là ứng dụng được chọn. Không lưu hình ảnh hoặc định dạng văn bản. Mật khẩu, khóa, số thẻ và nội dung từ trình quản lý mật khẩu sẽ bị bỏ qua. Tắt tính năng này sẽ xóa lịch sử.',
    clear: 'Xóa lịch sử',
    cleared: 'Đã xóa',
    pasteMore: 'Dán thêm',
  },
  ja: {
    title: 'クリップボード履歴',
    description:
      '初期設定ではオフです。オンにすると、GenOffice の使用中に最近のテキストを最大 20 件、このデバイスに保存します。画像や書式は保存しません。パスワード、キー、カード番号、パスワードマネージャーの内容は除外します。オフにすると履歴を消去します。',
    clear: '履歴を消去',
    cleared: '消去しました',
    pasteMore: '別の項目を貼り付け',
  },
  ko: {
    title: '클립보드 기록',
    description:
      '기본값은 꺼짐입니다. 켜면 GenOffice가 활성화된 동안 최근 텍스트 최대 20개를 이 기기에 저장합니다. 이미지와 서식은 저장하지 않습니다. 비밀번호, 키, 카드 번호, 비밀번호 관리자의 내용은 건너뜁니다. 끄면 기록을 지웁니다.',
    clear: '기록 지우기',
    cleared: '지웠습니다',
    pasteMore: '더 붙여넣기',
  },
  fr: {
    title: 'Historique du presse-papiers',
    description:
      'Désactivé par défaut. Une fois activé, GenOffice conserve sur cet appareil jusqu’à 20 textes récents lorsque l’application est au premier plan. Les images et la mise en forme ne sont pas conservées. Les mots de passe, clés, numéros de carte et contenus des gestionnaires de mots de passe sont ignorés. La désactivation efface l’historique.',
    clear: 'Effacer l’historique',
    cleared: 'Effacé',
    pasteMore: 'Coller davantage',
  },
  de: {
    title: 'Zwischenablageverlauf',
    description:
      'Standardmäßig deaktiviert. Aktiviert speichert GenOffice bis zu 20 aktuelle Texte auf diesem Gerät, während die App im Vordergrund ist. Bilder und Formatierungen werden nicht gespeichert. Passwörter, Schlüssel, Kartennummern und Inhalte von Passwortmanagern werden übersprungen. Beim Deaktivieren wird der Verlauf gelöscht.',
    clear: 'Verlauf löschen',
    cleared: 'Gelöscht',
    pasteMore: 'Weitere Einträge einfügen',
  },
  es: {
    title: 'Historial del portapapeles',
    description:
      'Desactivado de forma predeterminada. Al activarlo, GenOffice guarda hasta 20 textos recientes en este dispositivo mientras la aplicación está en primer plano. No guarda imágenes ni formato enriquecido. Omite contraseñas, claves, números de tarjeta y contenido de gestores de contraseñas. Al desactivarlo, se borra el historial.',
    clear: 'Borrar historial',
    cleared: 'Borrado',
    pasteMore: 'Pegar más',
  },
  th: {
    title: 'ประวัติคลิปบอร์ด',
    description:
      'ปิดไว้เป็นค่าเริ่มต้น เมื่อเปิด GenOffice จะบันทึกข้อความล่าสุดไม่เกิน 20 รายการไว้ในอุปกรณ์นี้ขณะแอปอยู่เบื้องหน้า โดยไม่บันทึกรูปภาพหรือรูปแบบข้อความ รหัสผ่าน คีย์ หมายเลขบัตร และเนื้อหาจากตัวจัดการรหัสผ่านจะถูกข้าม เมื่อปิดจะล้างประวัติ',
    clear: 'ล้างประวัติ',
    cleared: 'ล้างแล้ว',
    pasteMore: 'วางเพิ่มเติม',
  },
  id: {
    title: 'Riwayat papan klip',
    description:
      'Nonaktif secara default. Saat aktif, GenOffice menyimpan hingga 20 teks terbaru di perangkat ini selama aplikasi berada di depan. Gambar dan pemformatan tidak disimpan. Kata sandi, kunci, nomor kartu, dan konten pengelola kata sandi dilewati. Menonaktifkan akan menghapus riwayat.',
    clear: 'Hapus riwayat',
    cleared: 'Dihapus',
    pasteMore: 'Tempel lainnya',
  },
  ru: {
    title: 'История буфера обмена',
    description:
      'По умолчанию выключена. При включении GenOffice хранит на этом устройстве до 20 недавних текстов, пока приложение на переднем плане. Изображения и форматирование не сохраняются. Пароли, ключи, номера карт и данные менеджеров паролей пропускаются. При выключении история удаляется.',
    clear: 'Очистить историю',
    cleared: 'Очищено',
    pasteMore: 'Вставить ещё',
  },
  ar: {
    title: 'سجل الحافظة',
    description:
      'متوقف افتراضيًا. عند تشغيله، يحتفظ GenOffice بما يصل إلى 20 نصًا حديثًا على هذا الجهاز أثناء ظهور التطبيق في المقدمة. لا تُحفظ الصور أو التنسيقات. يتم تخطي كلمات المرور والمفاتيح وأرقام البطاقات ومحتوى مديري كلمات المرور. يؤدي إيقافه إلى مسح السجل.',
    clear: 'مسح السجل',
    cleared: 'تم المسح',
    pasteMore: 'لصق المزيد',
  },
  pt: {
    title: 'Histórico da área de transferência',
    description:
      'Desativado por padrão. Quando ativado, o GenOffice guarda até 20 textos recentes neste dispositivo enquanto o aplicativo está em primeiro plano. Imagens e formatação não são guardadas. Senhas, chaves, números de cartão e conteúdo de gerenciadores de senhas são ignorados. Desativar apaga o histórico.',
    clear: 'Limpar histórico',
    cleared: 'Limpo',
    pasteMore: 'Colar mais',
  },
  it: {
    title: 'Cronologia degli appunti',
    description:
      'Disattivata per impostazione predefinita. Se attiva, GenOffice conserva fino a 20 testi recenti su questo dispositivo mentre l’app è in primo piano. Immagini e formattazione non vengono salvate. Password, chiavi, numeri di carta e contenuti dei gestori di password vengono ignorati. La disattivazione cancella la cronologia.',
    clear: 'Cancella cronologia',
    cleared: 'Cancellata',
    pasteMore: 'Incolla altro',
  },
  pl: {
    title: 'Historia schowka',
    description:
      'Domyślnie wyłączona. Po włączeniu GenOffice zapisuje na tym urządzeniu do 20 ostatnich tekstów, gdy aplikacja jest na pierwszym planie. Obrazy i formatowanie nie są zapisywane. Hasła, klucze, numery kart i treści menedżerów haseł są pomijane. Wyłączenie usuwa historię.',
    clear: 'Wyczyść historię',
    cleared: 'Wyczyszczono',
    pasteMore: 'Wklej więcej',
  },
  cs: {
    title: 'Historie schránky',
    description:
      'Ve výchozím nastavení je vypnutá. Po zapnutí GenOffice ukládá na tomto zařízení až 20 posledních textů, když je aplikace v popředí. Obrázky a formátování se neukládají. Hesla, klíče, čísla karet a obsah správců hesel se vynechávají. Vypnutím se historie vymaže.',
    clear: 'Vymazat historii',
    cleared: 'Vymazáno',
    pasteMore: 'Vložit další',
  },
  nl: {
    title: 'Klembordgeschiedenis',
    description:
      'Standaard uitgeschakeld. Als dit is ingeschakeld, bewaart GenOffice maximaal 20 recente teksten op dit apparaat zolang de app op de voorgrond staat. Afbeeldingen en opmaak worden niet bewaard. Wachtwoorden, sleutels, kaartnummers en inhoud van wachtwoordbeheerders worden overgeslagen. Uitschakelen wist de geschiedenis.',
    clear: 'Geschiedenis wissen',
    cleared: 'Gewist',
    pasteMore: 'Meer plakken',
  },
  ms: {
    title: 'Sejarah papan klip',
    description:
      'Dimatikan secara lalai. Apabila dihidupkan, GenOffice menyimpan sehingga 20 teks terkini pada peranti ini semasa aplikasi berada di hadapan. Imej dan pemformatan tidak disimpan. Kata laluan, kunci, nombor kad dan kandungan pengurus kata laluan dilangkau. Mematikannya akan memadam sejarah.',
    clear: 'Kosongkan sejarah',
    cleared: 'Dikosongkan',
    pasteMore: 'Tampal lagi',
  },
  he: {
    title: 'היסטוריית הלוח',
    description:
      'כבויה כברירת מחדל. כשהיא מופעלת, GenOffice שומר עד 20 קטעי טקסט אחרונים במכשיר הזה כשהאפליקציה בחזית. תמונות ועיצוב עשיר אינם נשמרים. סיסמאות, מפתחות, מספרי כרטיסים ותוכן ממנהלי סיסמאות מדולגים. כיבוי מוחק את ההיסטוריה.',
    clear: 'ניקוי ההיסטוריה',
    cleared: 'נמחקה',
    pasteMore: 'הדבק עוד',
  },
  hi: {
    title: 'क्लिपबोर्ड इतिहास',
    description:
      'डिफ़ॉल्ट रूप से बंद। चालू होने पर, ऐप सामने रहने के दौरान GenOffice इस डिवाइस पर हाल के अधिकतम 20 टेक्स्ट रखता है। चित्र और फ़ॉर्मैटिंग सहेजे नहीं जाते। पासवर्ड, कुंजियाँ, कार्ड नंबर और पासवर्ड मैनेजर की सामग्री छोड़ दी जाती है। बंद करने पर इतिहास मिट जाता है।',
    clear: 'इतिहास मिटाएँ',
    cleared: 'मिटा दिया',
    pasteMore: 'और चिपकाएँ',
  },
}

const PASTE_MORE_EMPTY: Record<string, string> = {
  en: 'Copy some text first',
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

export function clipboardHistoryLabels(lang: string): ClipboardHistoryLabels {
  const labels = LABELS[lang] ?? EN
  return {
    ...labels,
    description: `${labels.description} ${NORMAL_PASTE_NOTE[lang] ?? NORMAL_PASTE_NOTE.en}`,
    pasteMoreEmpty: PASTE_MORE_EMPTY[lang] ?? EN.pasteMoreEmpty,
  }
}
