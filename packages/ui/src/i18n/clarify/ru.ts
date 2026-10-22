import type zh from './zh'

const strings = {
  aiActionStep: 'Шаг {step}/{total}: {text} (Esc — отмена)',
  aiActionApprove: 'Разрешить',
  aiActionDeny: 'Отклонить',
  aiActionConfirm: 'Разрешить это действие?',
  aiActionIndex: 'Открыть индекс',
  aiActionSettings: 'Открыть настройки',
  aiActionNewChat: 'Начать новый чат',
  aiActionPrint: 'Открыть Файл → Печать',
  aiActionExportPdf: 'Экспортировать в PDF',
  aiActionFile: 'Открыть меню Файл',
  aiActionHandoff: 'Продолжите в диалоге; результат зависит от вашего выбора.',
  aiClarifyTitle: 'Несколько коротких вопросов, чтобы страница лучше отвечала вашим задачам',
  aiClarifyDecide: 'Решите за меня',
  aiClarifyDecideAnswer: '(решите за меня)',
  aiClarifyMulti: 'Несколько вариантов',
  aiClarifyNext: 'Далее',
  aiClarifyPrev: 'Назад',
  aiClarifyOther: 'Другое (впишите свой вариант)',
  aiClarifySelected: 'выбрано: {n}',
  aiClarifySkip: 'Пропустить опрос',
  aiClarifySubmit: 'Отправить',
} satisfies Record<keyof typeof zh, string>

export default strings
