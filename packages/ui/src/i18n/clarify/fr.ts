import type zh from './zh'

const strings = {
  aiActionStep: 'Étape {step}/{total} : {text} (Échap pour annuler)',
  aiActionApprove: 'Autoriser',
  aiActionDeny: 'Refuser',
  aiActionConfirm: 'Autoriser cette action ?',
  aiActionIndex: 'Ouvrir l’index',
  aiActionSettings: 'Ouvrir les paramètres',
  aiActionNewChat: 'Démarrer une discussion',
  aiActionPrint: 'Ouvrir Fichier → Imprimer',
  aiActionExportPdf: 'Exporter en PDF',
  aiActionFile: 'Ouvrir le menu Fichier',
  aiActionHandoff: 'Continuez dans la boîte de dialogue ; le résultat dépend de votre choix.',
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
