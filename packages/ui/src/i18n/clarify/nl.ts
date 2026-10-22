import type zh from './zh'

const strings = {
  aiActionStep: 'Stap {step}/{total}: {text} (Esc om te annuleren)',
  aiActionApprove: 'Toestaan',
  aiActionDeny: 'Weigeren',
  aiActionConfirm: 'Deze actie toestaan?',
  aiActionIndex: 'Index openen',
  aiActionSettings: 'Instellingen openen',
  aiActionNewChat: 'Nieuwe chat starten',
  aiActionPrint: 'Bestand → Afdrukken openen',
  aiActionExportPdf: 'Exporteren als PDF',
  aiActionFile: 'Bestandsmenu openen',
  aiActionHandoff: 'Ga verder in het dialoogvenster; het resultaat hangt af van uw keuze.',
  aiClarifyTitle: 'Een paar korte vragen om de pagina op u af te stemmen',
  aiClarifyDecide: 'Beslis voor mij',
  aiClarifyDecideAnswer: '(beslis voor mij)',
  aiClarifyMulti: 'Meerdere keuzes',
  aiClarifyNext: 'Volgende',
  aiClarifyPrev: 'Vorige',
  aiClarifyOther: 'Anders (typ zelf)',
  aiClarifySelected: '{n} geselecteerd',
  aiClarifySkip: 'Enquête overslaan',
  aiClarifySubmit: 'Verzenden',
} satisfies Record<keyof typeof zh, string>

export default strings
