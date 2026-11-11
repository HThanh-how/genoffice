import { useEffect, useRef, useState } from 'react'
import { SettingsRow } from './settings-ui/SettingsCard'
import {
  BLUR_MAX,
  DIM_MAX,
  DIM_MIN,
  emptyLiveBackgroundState,
  type LiveBackgroundPrefs,
  type LiveBackgroundState,
  type WallpaperEngineListing,
} from '../../../shared/fork/live-background'
import { liveBackgroundCopy, liveBackgroundProblem } from './live-background-strings'

/** Settings -> General group: the optional live background (off by default). */
export function LiveBackgroundSettings({ lang }: { lang: string }) {
  const c = liveBackgroundCopy(lang)
  const api = window.aiOffice
  const [state, setState] = useState<LiveBackgroundState>(() => emptyLiveBackgroundState())
  const [workshop, setWorkshop] = useState<WallpaperEngineListing[]>([])
  const [scanning, setScanning] = useState(!!api.scanLiveBackgroundWorkshop)
  const [failedUrl, setFailedUrl] = useState('')
  const [busy, setBusy] = useState(false)
  // sliders move freely; the value is saved shortly after the last change
  const [dim, setDim] = useState<number | null>(null)
  const [blur, setBlur] = useState<number | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<Partial<LiveBackgroundPrefs>>({})

  useEffect(() => {
    let alive = true
    const scan = api.scanLiveBackgroundWorkshop?.()
    void scan
      ?.then((items) => {
        if (alive) setWorkshop(items ?? [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setScanning(false)
      })
    void api.getLiveBackground?.().then((next) => {
      if (alive && next) setState(next)
    }).catch(() => undefined)
    const off = api.onLiveBackgroundChanged?.((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      off?.()
      window.clearTimeout(timer.current)
    }
  }, [api])

  const run = async (job: () => Promise<LiveBackgroundState>) => {
    setBusy(true)
    try {
      setState(await job())
    } finally {
      setBusy(false)
    }
  }
  const patch = (changes: Partial<LiveBackgroundPrefs>) =>
    run(() => api.setLiveBackgroundPrefs(changes))
  const patchSoon = (changes: Partial<LiveBackgroundPrefs>) => {
    pending.current = { ...pending.current, ...changes }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const batch = pending.current
      pending.current = {}
      void api.setLiveBackgroundPrefs(batch).then((next) => {
        setState(next)
        setDim(null)
        setBlur(null)
      })
    }, 250)
  }

  const { prefs } = state
  const problem = liveBackgroundProblem(state, lang)
  const sourceLabel = prefs.sourcePath ? prefs.sourcePath : c.none
  const itemLine =
    state.count > 1
      ? `${state.title} · ${c.itemOf((prefs.index % state.count) + 1, state.count)}`
      : state.title
  const origin = state.media?.origin === 'wallpaper-engine' ? ` · ${c.wallpaperEngine}` : ''

  return (
    <>
      <SettingsRow className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{c.show}</div>
            <div className="set-field-desc">{c.showHint}</div>
          </div>
        </div>
        <button
          type="button"
          className="set-switch"
          role="switch"
          aria-checked={prefs.enabled}
          aria-label={c.show}
          disabled={busy || !api.setLiveBackgroundPrefs}
          onClick={() => void patch({ enabled: !prefs.enabled })}
        />
      </SettingsRow>

      <SettingsRow className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{c.opening}</div>
          <div className="set-field-desc">{c.openingHint}</div>
        </div>
        <button
          type="button"
          className="set-switch"
          role="switch"
          aria-checked={prefs.openingEnabled}
          aria-label={c.opening}
          disabled={busy || !api.setLiveBackgroundPrefs}
          onClick={() => void patch({ openingEnabled: !prefs.openingEnabled })}
        />
      </SettingsRow>

      {(prefs.enabled || prefs.openingEnabled) && (
        <>
          <SettingsRow className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{c.source}</div>
                <div className="set-field-desc live-bg-path" title={prefs.sourcePath}>
                  {sourceLabel}
                </div>
                {state.status === 'ok' && (
                  <div className="set-field-desc">
                    {itemLine}
                    {origin}
                  </div>
                )}
                {state.skipped > 0 && (
                  <div className="set-field-desc">{c.skipped(state.skipped)}</div>
                )}
                {state.media?.kind === 'video' && (
                  <video
                    key={state.media.url}
                    src={state.media.url}
                    muted
                    preload="auto"
                    style={{ display: 'none' }}
                    onError={() => setFailedUrl(state.media?.url ?? '')}
                  />
                )}
                {state.media?.url && failedUrl === state.media.url && (
                  <div className="set-field-desc live-bg-problem">{c.decodeError}</div>
                )}
                {problem && <div className="set-field-desc live-bg-problem">{problem}</div>}
                <div className="set-field-desc">{c.folderHint}</div>
              </div>
            </div>
            <div className="live-bg-actions">
              <button
                type="button"
                className="set-btn"
                disabled={busy || !api.pickLiveBackgroundSource}
                onClick={() => void run(() => api.pickLiveBackgroundSource('file'))}
              >
                {c.chooseFile}
              </button>
              <button
                type="button"
                className="set-btn"
                disabled={busy || !api.pickLiveBackgroundSource}
                onClick={() => void run(() => api.pickLiveBackgroundSource('folder'))}
              >
                {c.chooseFolder}
              </button>
              <button
                type="button"
                className="set-btn"
                disabled={busy || !api.setLiveBackgroundPrefs || !prefs.sourcePath}
                onClick={() => void patch({ sourcePath: '' })}
              >
                {c.clear}
              </button>
            </div>
          </SettingsRow>

          <SettingsRow className="set-field">
            <div className="set-field-text">
              <div className="set-field-label">{c.workshop}</div>
              <div className="set-field-desc">
                {scanning ? c.scanning : workshop.length ? c.workshopHint : c.workshopEmpty}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  maxHeight: 260,
                  overflowY: 'auto',
                }}
              >
                {workshop.map((item, index) => (
                  <button
                    type="button"
                    className="set-btn"
                    key={index}
                    disabled={busy || !api.selectLiveBackgroundWorkshop || !!item.reason}
                    title={item.reason ? c.reasons[item.reason] : item.title}
                    onClick={() => void run(() => api.selectLiveBackgroundWorkshop(index))}
                    style={{ width: 140, whiteSpace: 'normal' }}
                  >
                    {item.previewUrl && (
                      <img
                        src={item.previewUrl}
                        alt=""
                        style={{ width: '100%', height: 70, objectFit: 'cover' }}
                      />
                    )}
                    <span>{item.title}</span>
                    {item.reason && <span> ? {c.reasons[item.reason]}</span>}
                  </button>
                ))}
              </div>
            </div>
          </SettingsRow>

          {state.count > 1 && (
            <SettingsRow className="set-field">
              <div className="set-field-text">
                <div className="set-field-label">{c.item}</div>
              </div>
              <div className="live-bg-actions">
                <button
                  type="button"
                  className="set-btn"
                  disabled={busy || !api.setLiveBackgroundPrefs}
                  onClick={() =>
                    void patch({ index: (prefs.index + state.count - 1) % state.count })
                  }
                >
                  {c.prev}
                </button>
                <button
                  type="button"
                  className="set-btn"
                  disabled={busy || !api.setLiveBackgroundPrefs}
                  onClick={() => void patch({ index: (prefs.index + 1) % state.count })}
                >
                  {c.next}
                </button>
              </div>
            </SettingsRow>
          )}

          <SettingsRow className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{c.dim}</div>
                <div className="set-field-desc">{c.dimHint}</div>
              </div>
            </div>
            <input
              type="range"
              disabled={!api.setLiveBackgroundPrefs}
              className="live-bg-range"
              min={DIM_MIN}
              max={DIM_MAX}
              value={dim ?? prefs.dim}
              aria-label={c.dim}
              onChange={(e) => {
                const value = Number(e.target.value)
                setDim(value)
                patchSoon({ dim: value })
              }}
            />
          </SettingsRow>

          <SettingsRow className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{c.blur}</div>
                <div className="set-field-desc">{c.blurHint}</div>
              </div>
            </div>
            <input
              type="range"
              disabled={!api.setLiveBackgroundPrefs}
              className="live-bg-range"
              min={0}
              max={BLUR_MAX}
              value={blur ?? prefs.blur}
              aria-label={c.blur}
              onChange={(e) => {
                const value = Number(e.target.value)
                setBlur(value)
                patchSoon({ blur: value })
              }}
            />
          </SettingsRow>

          <SettingsRow className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{c.saver}</div>
                <div className="set-field-desc">{c.saverHint}</div>
              </div>
            </div>
            <button
              type="button"
              className="set-switch"
              role="switch"
              aria-checked={prefs.saver}
              aria-label={c.saver}
              disabled={busy || !api.setLiveBackgroundPrefs}
              onClick={() => void patch({ saver: !prefs.saver })}
            />
          </SettingsRow>
        </>
      )}
    </>
  )
}
