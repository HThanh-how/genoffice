import type { OpeningApp } from '../../../../shared/opening-scenes-meta'

/** App colors and human-readable names (the letter is the one on the real opening card's badge). */
export const APP_INFO: Record<
  OpeningApp,
  { nameEn: string; nameVi: string; ext: string; color: string; letter: string }
> = {
  docs: { nameEn: 'Word', nameVi: 'Word', ext: '.docx', color: '#2b7cd3', letter: 'W' },
  sheets: { nameEn: 'Excel', nameVi: 'Excel', ext: '.xlsx', color: '#107c41', letter: 'X' },
  slides: {
    nameEn: 'PowerPoint',
    nameVi: 'PowerPoint',
    ext: '.pptx',
    color: '#d24726',
    letter: 'P',
  },
  pdf: { nameEn: 'PDF', nameVi: 'PDF', ext: '.pdf', color: '#e03e2d', letter: 'PDF' },
  markdown: { nameEn: 'Markdown', nameVi: 'Markdown', ext: '.md', color: '#3880ff', letter: 'M' },
  html: { nameEn: 'HTML', nameVi: 'HTML', ext: '.html', color: '#e44d26', letter: '</>' },
}
