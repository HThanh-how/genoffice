import type zh from './zh'

const strings = {
  aiActionStep: '{step}/{total}. lépés: {text} (Esc a megszakításhoz)',
  aiActionApprove: 'Jóváhagyás',
  aiActionDeny: 'Elutasítás',
  aiActionConfirm: 'Engedélyezed ezt a műveletet?',
  aiActionIndex: 'Index megnyitása',
  aiActionSettings: 'Beállítások megnyitása',
  aiActionNewChat: 'Új csevegés indítása',
  aiActionPrint: 'Fájl → Nyomtatás megnyitása',
  aiActionExportPdf: 'Exportálás PDF-ként',
  aiActionFile: 'A Fájl menü megnyitása',
  aiActionHandoff: 'Folytasd a párbeszédablakban; a befejezés a választásodtól függ.',
  aiClarifyTitle: 'Néhány gyors kérdés, hogy az oldalt rád szabjuk',
  aiClarifyDecide: 'Döntsön helyettem',
  aiClarifyDecideAnswer: '(döntsön helyettem)',
  aiClarifyMulti: 'Több választás',
  aiClarifyNext: 'Tovább',
  aiClarifyPrev: 'Vissza',
  aiClarifyOther: 'Egyéb (beírom)',
  aiClarifySelected: '{n} kijelölve',
  aiClarifySkip: 'Kérdőív kihagyása',
  aiClarifySubmit: 'Küldés',
} satisfies Record<keyof typeof zh, string>

export default strings
