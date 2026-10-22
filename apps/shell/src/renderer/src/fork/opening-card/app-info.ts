import { SPLASH_THEMES } from '../../../../shared/opening-page'
import type { OpeningApp } from '../../../../shared/opening-scenes-meta'

/**
 * App names and the badge of each app. Colour and letter are those of the real opening card
 * (`SPLASH_THEMES`), so an app's mark in the studio is the mark on the card it opens with.
 */
export const APP_INFO: Record<
  OpeningApp,
  { nameEn: string; nameVi: string; ext: string; color: string; letter: string }
> = {
  docs: { nameEn: 'Word', nameVi: 'Word', ext: '.docx', ...SPLASH_THEMES.docs },
  sheets: { nameEn: 'Excel', nameVi: 'Excel', ext: '.xlsx', ...SPLASH_THEMES.sheets },
  slides: { nameEn: 'PowerPoint', nameVi: 'PowerPoint', ext: '.pptx', ...SPLASH_THEMES.slides },
  pdf: { nameEn: 'PDF', nameVi: 'PDF', ext: '.pdf', ...SPLASH_THEMES.pdf },
  markdown: { nameEn: 'Markdown', nameVi: 'Markdown', ext: '.md', ...SPLASH_THEMES.markdown },
  html: { nameEn: 'HTML', nameVi: 'HTML', ext: '.html', ...SPLASH_THEMES.html },
}
