import type zh from './zh'

const strings = {
  aiActionStep: 'Krok {step}/{total}: {text} (Esc anuluje)',
  aiActionApprove: 'Zezwól',
  aiActionDeny: 'Odmów',
  aiActionConfirm: 'Zezwolić na tę czynność?',
  aiActionIndex: 'Otwórz indeks',
  aiActionSettings: 'Otwórz ustawienia',
  aiActionNewChat: 'Rozpocznij nowy czat',
  aiActionPrint: 'Otwórz Plik → Drukuj',
  aiActionExportPdf: 'Eksportuj do PDF',
  aiActionFile: 'Otwórz menu Plik',
  aiActionHandoff: 'Kontynuuj w oknie dialogowym; wynik zależy od Twojego wyboru.',
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
