import type zh from './zh'

const strings = {
  aiClarifyTitle: 'Ein paar kurze Fragen, um die Seite auf Sie zuzuschneiden',
  aiClarifyDecide: 'Entscheide für mich',
  aiClarifyDecideAnswer: '(entscheide für mich)',
  aiClarifyMulti: 'Mehrfachauswahl',
  aiClarifyNext: 'Weiter',
  aiClarifyPrev: 'Zurück',
  aiClarifyOther: 'Sonstiges (eingeben)',
  aiClarifySelected: '{n} ausgewählt',
  aiClarifySkip: 'Umfrage überspringen',
  aiClarifySubmit: 'Senden',
} satisfies Record<keyof typeof zh, string>

export default strings
