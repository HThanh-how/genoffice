import type zh from './zh'

const strings = {
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
