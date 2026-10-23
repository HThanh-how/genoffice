import type { zh } from './zh'

export const copy = {
  appearance: 'Appearance',
  ai: 'AI panel',
  files: 'Files & saving',
  legacy: 'Legacy Office files',
  legacyHint: '.doc and .ppt conversion',
  privacy: 'Privacy & clipboard',
  opening: 'Opening effects',
  openingHint: 'A scene while a file opens',
  appearanceHint: 'Language, theme and reading comfort',
  aiHint: 'Make the assistant fit your workflow',
  filesHint: 'Default folders and automatic saving',
  privacyHint: 'Choose what the app remembers and shares',
  modelHint: 'Choose a provider and configure its connection',
  searchHint: 'Choose how the assistant finds sources',
  mediaProviderHint: 'Choose a provider and model for this capability',
  aboutTitle: 'Application & updates',
  aboutHint: 'Version, update sources and release channel',
  studioHint: 'Choose, preview and customize your opening cards',
  advancedHint: 'Import and preview your own HTML scenes',
} satisfies Record<keyof typeof zh, string>
