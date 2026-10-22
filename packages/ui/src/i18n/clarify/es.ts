import type zh from './zh'

const strings = {
  aiClarifyTitle: 'Unas preguntas rápidas para adaptar la página a ti',
  aiClarifyDecide: 'Decide por mí',
  aiClarifyDecideAnswer: '(decide por mí)',
  aiClarifyMulti: 'Selección múltiple',
  aiClarifyNext: 'Siguiente',
  aiClarifyPrev: 'Anterior',
  aiClarifyOther: 'Otro (escríbelo)',
  aiClarifySelected: '{n} seleccionados',
  aiClarifySkip: 'Omitir encuesta',
  aiClarifySubmit: 'Enviar',
} satisfies Record<keyof typeof zh, string>

export default strings
