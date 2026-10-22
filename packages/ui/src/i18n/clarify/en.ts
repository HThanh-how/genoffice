import type zh from './zh'

const strings = {
  aiClarifyTitle: 'A few quick questions to tailor the page to you',
  aiClarifyDecide: 'Decide for me',
  aiClarifyDecideAnswer: '(decide for me)',
  aiClarifyMulti: 'Multiple choice',
  aiClarifyNext: 'Next',
  aiClarifyPrev: 'Previous',
  aiClarifyOther: 'Other (type in)',
  aiClarifySelected: '{n} selected',
  aiClarifySkip: 'Skip survey',
  aiClarifySubmit: 'Send',
} satisfies Record<keyof typeof zh, string>

export default strings
