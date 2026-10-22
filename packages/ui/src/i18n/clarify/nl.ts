import type zh from './zh'

const strings = {
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
