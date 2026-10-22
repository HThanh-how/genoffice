import type zh from './zh'

const strings = {
  aiActionStep: 'Passaggio {step}/{total}: {text} (Esc per annullare)',
  aiActionApprove: 'Consenti',
  aiActionDeny: 'Nega',
  aiActionConfirm: 'Consentire questa azione?',
  aiActionIndex: 'Apri indice',
  aiActionSettings: 'Apri impostazioni',
  aiActionNewChat: 'Avvia una nuova chat',
  aiActionPrint: 'Apri File → Stampa',
  aiActionExportPdf: 'Esporta in PDF',
  aiActionFile: 'Apri il menu File',
  aiActionHandoff: 'Continua nella finestra di dialogo; il risultato dipende dalla scelta.',
  aiClarifyTitle: 'Qualche domanda rapida per adattare la pagina alle tue esigenze',
  aiClarifyDecide: 'Decidi tu per me',
  aiClarifyDecideAnswer: '(decidi tu per me)',
  aiClarifyMulti: 'Scelta multipla',
  aiClarifyNext: 'Avanti',
  aiClarifyPrev: 'Indietro',
  aiClarifyOther: 'Altro (da digitare)',
  aiClarifySelected: '{n} selezionati',
  aiClarifySkip: 'Salta sondaggio',
  aiClarifySubmit: 'Invia',
} satisfies Record<keyof typeof zh, string>

export default strings
