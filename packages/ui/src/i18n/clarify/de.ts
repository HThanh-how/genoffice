import type zh from './zh'

const strings = {
  aiActionStep: 'Schritt {step}/{total}: {text} (Esc zum Abbrechen)',
  aiActionApprove: 'Erlauben',
  aiActionDeny: 'Ablehnen',
  aiActionConfirm: 'Diese Aktion erlauben?',
  aiActionIndex: 'Index öffnen',
  aiActionSettings: 'Einstellungen öffnen',
  aiActionNewChat: 'Neuen Chat starten',
  aiActionPrint: 'Datei → Drucken öffnen',
  aiActionExportPdf: 'Als PDF exportieren',
  aiActionFile: 'Dateimenü öffnen',
  aiActionHandoff: 'Im Dialog fortfahren; das Ergebnis hängt von Ihrer Auswahl ab.',
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
