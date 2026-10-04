import type { UpdateUiState, UpdateWindowApi } from '../../shared/update-api'

// exposed by src/preload/update.ts
const api = (window as unknown as { aiOfficeUpdate: UpdateWindowApi }).aiOfficeUpdate

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const headline = el('headline')
const verCurrent = el('ver-current')
const verNew = el('ver-new')
const desc = el('desc')
const progress = el('progress')
const bar = el('bar')
const progressText = el('progress-text')
const percentText = el('percent')
const action = el('action') as HTMLButtonElement
const later = el('later') as HTMLButtonElement
const close = el('close') as HTMLButtonElement

let phase: UpdateUiState['phase'] = 'available'
let initialized = false

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
api.onThemeChanged(applyTheme)
void api
  .getTheme()
  .then(applyTheme)
  .catch(() => applyTheme('system'))

function render(state: UpdateUiState): void {
  phase = state.phase
  const s = state.strings

  document.documentElement.lang = state.lang
  document.title = s.title
  headline.textContent = s.headline
  verCurrent.textContent = `v${state.currentVersion}`
  verNew.textContent = `v${state.version}`
  later.textContent = s.later
  close.setAttribute('aria-label', s.later)
  close.title = s.later
  el('card').dataset.phase = state.phase

  desc.classList.toggle('error', state.phase === 'error')

  switch (state.phase) {
    case 'available':
      desc.textContent = s.desc
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = s.download
      break
    case 'downloading': {
      desc.textContent = s.desc
      progress.style.display = 'flex'
      action.style.display = 'none'
      const pct = Math.max(0, Math.min(100, Math.round(state.percent)))
      bar.style.width = `${pct}%`
      progress.setAttribute('aria-valuenow', String(pct))
      progress.setAttribute('aria-valuetext', `${s.downloading} ${pct}%`)
      progressText.textContent = s.downloading
      percentText.textContent = `${pct}%`
      break
    }
    case 'downloaded':
      desc.textContent = s.desc
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = s.install
      break
    case 'error':
      desc.textContent = s.failed
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = s.retry
      break
    case 'manual':
      desc.textContent = s.manualDesc
      progress.style.display = 'none'
      action.style.display = ''
      action.textContent = s.openDownload
      break
  }
  if (!initialized) {
    initialized = true
    const firstAction = phase === 'downloading' ? later : action
    firstAction.focus({ preventScroll: true })
  } else if (document.activeElement === action && phase === 'downloading') {
    later.focus({ preventScroll: true })
  }
}

action.addEventListener('click', () => {
  if (phase === 'downloaded') api.install()
  else if (phase === 'manual') api.openDownload()
  else api.download()
})
later.addEventListener('click', () => api.later())
close.addEventListener('click', () => api.later())
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    api.later()
  }
})

api.onState(render)
void api.getState().then((state) => {
  if (state) render(state)
})
