import type zh from './zh'

const strings = {
  aiActionStep: 'Etapa {step}/{total}: {text} (Esc para cancelar)',
  aiActionApprove: 'Permitir',
  aiActionDeny: 'Negar',
  aiActionConfirm: 'Permitir esta ação?',
  aiActionIndex: 'Abrir índice',
  aiActionSettings: 'Abrir configurações',
  aiActionNewChat: 'Iniciar nova conversa',
  aiActionPrint: 'Abrir Arquivo → Imprimir',
  aiActionExportPdf: 'Exportar para PDF',
  aiActionFile: 'Abrir o menu Arquivo',
  aiActionHandoff: 'Continue na caixa de diálogo; o resultado depende da sua escolha.',
  aiClarifyTitle: 'Algumas perguntas rápidas para adaptar a página a você',
  aiClarifyDecide: 'Decida por mim',
  aiClarifyDecideAnswer: '(decida por mim)',
  aiClarifyMulti: 'Seleção múltipla',
  aiClarifyNext: 'Próxima',
  aiClarifyPrev: 'Anterior',
  aiClarifyOther: 'Outro (digite)',
  aiClarifySelected: '{n} selecionados',
  aiClarifySkip: 'Pular pesquisa',
  aiClarifySubmit: 'Enviar',
} satisfies Record<keyof typeof zh, string>

export default strings
