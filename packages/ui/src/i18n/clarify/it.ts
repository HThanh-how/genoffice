import type zh from './zh'

const strings = {
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
