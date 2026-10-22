import type zh from './zh'

const strings = {
  aiClarifyTitle: 'Quelques questions rapides pour adapter la page à vos besoins',
  aiClarifyDecide: 'Décidez pour moi',
  aiClarifyDecideAnswer: '(décidez pour moi)',
  aiClarifyMulti: 'Choix multiple',
  aiClarifyNext: 'Suivant',
  aiClarifyPrev: 'Précédent',
  aiClarifyOther: 'Autre (à saisir)',
  aiClarifySelected: '{n} sélectionnés',
  aiClarifySkip: 'Ignorer le questionnaire',
  aiClarifySubmit: 'Envoyer',
} satisfies Record<keyof typeof zh, string>

export default strings
