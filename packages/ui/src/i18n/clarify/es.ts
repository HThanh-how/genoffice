import type zh from './zh'

const strings = {
  aiActionStep: 'Paso {step}/{total}: {text} (Esc para cancelar)',
  aiActionApprove: 'Permitir',
  aiActionDeny: 'Denegar',
  aiActionConfirm: '¿Permitir esta acción?',
  aiActionIndex: 'Abrir índice',
  aiActionSettings: 'Abrir ajustes',
  aiActionNewChat: 'Iniciar un chat nuevo',
  aiActionPrint: 'Abrir Archivo → Imprimir',
  aiActionExportPdf: 'Exportar a PDF',
  aiActionFile: 'Abrir el menú Archivo',
  aiActionHandoff: 'Continúa en el diálogo; el resultado depende de tu elección.',
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
