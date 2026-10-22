import type zh from './zh'

const strings = {
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
