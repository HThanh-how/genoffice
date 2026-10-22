import type zh from './zh'

const strings = {
  aiActionStep: 'Step {step}/{total}: {text} (Esc to cancel)',
  aiActionApprove: 'Approve',
  aiActionDeny: 'Deny',
  aiActionConfirm: 'Allow this action?',
  aiActionIndex: 'Open Index',
  aiActionSettings: 'Open Settings',
  aiActionNewChat: 'Start a new chat',
  aiActionPrint: 'Open File → Print',
  aiActionExportPdf: 'Export as PDF',
  aiActionFile: 'Open the File menu',
  aiActionHandoff: 'Continue in the dialog; completion depends on your choice.',
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
