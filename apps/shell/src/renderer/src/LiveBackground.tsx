import { useEffect, useRef, useState } from 'react'
import {
  normalizeLiveBackgroundState,
  type LiveBackgroundState,
} from '../../shared/fork/live-background'
import './live-background.css'

interface BatteryLike {
  charging: boolean
  addEventListener(type: 'chargingchange', cb: () => void): void
  removeEventListener(type: 'chargingchange', cb: () => void): void
}

/**
 * Optional picture / looping video behind Home. Everything is lazy: with the feature off (the default) this renders
 * nothing and never asks for media; the saved state is read after first paint, never before.
 */
export function LiveBackground({ homeActive }: { homeActive: boolean }) {
  const [state, setState] = useState<LiveBackgroundState | null>(null)
  // tracked per media URL, so a settings tweak (same file) never replays the fade-in or clears an error
  const [failedUrl, setFailedUrl] = useState('')
  const [readyUrl, setReadyUrl] = useState('')
  const [focused, setFocused] = useState(() => document.hasFocus())
  const [hidden, setHidden] = useState(() => document.hidden)
  const [onBattery, setOnBattery] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  // state: loaded once after the first frame, then pushed by the main process
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.aiOffice
        .getLiveBackground?.()
        .then((next) => {
          if (alive && next) setState(normalizeLiveBackgroundState(next))
        })
        .catch(() => undefined)
    }
    const timer = window.setTimeout(load, 0)
    const off = window.aiOffice.onLiveBackgroundChanged?.((next) => setState(next))
    return () => {
      alive = false
      window.clearTimeout(timer)
      off?.()
    }
  }, [])

  const media = state?.prefs.enabled ? state.media : null
  const saver = state?.prefs.saver ?? true
  const failed = !!media && failedUrl === media.url
  const ready = !!media && readyUrl === media.url
  const isVideo = media?.kind === 'video' && !failed

  // window visibility / focus: Chromium reports minimised and fully covered windows as hidden
  useEffect(() => {
    if (!isVideo) return
    const onVisibility = () => setHidden(document.hidden)
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    setHidden(document.hidden)
    setFocused(document.hasFocus())
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [isVideo])

  // battery (only when the saver is on): unplugged -> hold the video still
  useEffect(() => {
    if (!isVideo || !saver) {
      setOnBattery(false)
      return
    }
    let alive = true
    let battery: BatteryLike | null = null
    const sync = () => {
      if (alive && battery) setOnBattery(!battery.charging)
    }
    const getBattery = (navigator as unknown as { getBattery?: () => Promise<BatteryLike> })
      .getBattery
    void getBattery
      ?.call(navigator)
      .then((b) => {
        if (!alive) return
        battery = b
        b.addEventListener('chargingchange', sync)
        sync()
      })
      .catch(() => undefined)
    return () => {
      alive = false
      battery?.removeEventListener('chargingchange', sync)
    }
  }, [isVideo, saver])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduceMotion(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const shouldPlay =
    isVideo && homeActive && !hidden && !reduceMotion && (!saver || (focused && !onBattery))

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (shouldPlay) void video.play().catch(() => undefined)
    else video.pause()
  }, [shouldPlay, media?.url])

  // the stylesheet lets Home's panels go see-through only while a background is really showing
  const showing = !!media && !(media.kind === 'video' && failed && !media.posterUrl)
  useEffect(() => {
    document.body.classList.toggle('live-bg-on', showing)
    return () => document.body.classList.remove('live-bg-on')
  }, [showing])

  if (!state || !media || !showing) return null
  const prefs = state.prefs
  const blurStyle =
    prefs.blur > 0 ? { filter: `blur(${prefs.blur}px)`, transform: 'scale(1.06)' } : undefined

  return (
    <div className="live-bg" aria-hidden="true" data-kind={media.kind}>
      {isVideo ? (
        <video
          ref={videoRef}
          key={media.url}
          className={'live-bg-media' + (ready ? ' ready' : '')}
          style={blurStyle}
          src={media.url}
          poster={media.posterUrl ?? undefined}
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          onLoadedData={() => setReadyUrl(media.url)}
          onError={() => setFailedUrl(media.url)}
        />
      ) : (
        <img
          key={media.url}
          className={'live-bg-media' + (ready ? ' ready' : '')}
          style={blurStyle}
          src={failed && media.posterUrl ? media.posterUrl : media.url}
          alt=""
          draggable={false}
          onLoad={() => setReadyUrl(media.url)}
          onError={() => setFailedUrl(media.url)}
        />
      )}
      <div className="live-bg-scrim" style={{ opacity: prefs.dim / 100 }} />
    </div>
  )
}
