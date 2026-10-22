import type zh from './zh'

const strings = {
  aiClarifyTitle: 'Kilka szybkich pytań, aby dopasować stronę do twoich potrzeb',
  aiClarifyDecide: 'Zdecyduj za mnie',
  aiClarifyDecideAnswer: '(zdecyduj za mnie)',
  aiClarifyMulti: 'Wielokrotny wybór',
  aiClarifyNext: 'Dalej',
  aiClarifyPrev: 'Wstecz',
  aiClarifyOther: 'Inne (wpisz)',
  aiClarifySelected: 'wybrano: {n}',
  aiClarifySkip: 'Pomiń ankietę',
  aiClarifySubmit: 'Wyślij',
} satisfies Record<keyof typeof zh, string>

export default strings
