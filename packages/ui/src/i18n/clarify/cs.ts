import type zh from './zh'

const strings = {
  aiActionStep: 'Krok {step}/{total}: {text} (Esc zruší)',
  aiActionApprove: 'Povolit',
  aiActionDeny: 'Odmítnout',
  aiActionConfirm: 'Povolit tuto akci?',
  aiActionIndex: 'Otevřít index',
  aiActionSettings: 'Otevřít nastavení',
  aiActionNewChat: 'Zahájit nový chat',
  aiActionPrint: 'Otevřít Soubor → Tisk',
  aiActionExportPdf: 'Exportovat do PDF',
  aiActionFile: 'Otevřít nabídku Soubor',
  aiActionHandoff: 'Pokračujte v dialogu; výsledek závisí na vaší volbě.',
  aiClarifyTitle: 'Několik rychlých otázek, aby stránka seděla přesně vám',
  aiClarifyDecide: 'Rozhodni za mě',
  aiClarifyDecideAnswer: '(rozhodni za mě)',
  aiClarifyMulti: 'Více možností',
  aiClarifyNext: 'Další',
  aiClarifyPrev: 'Předchozí',
  aiClarifyOther: 'Jiné (napište)',
  aiClarifySelected: 'Vybráno: {n}',
  aiClarifySkip: 'Přeskočit dotazník',
  aiClarifySubmit: 'Odeslat',
} satisfies Record<keyof typeof zh, string>

export default strings
