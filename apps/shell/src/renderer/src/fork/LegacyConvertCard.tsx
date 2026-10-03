import { useEffect, useRef, useState } from 'react'
import type { HomeApi, LegacyConvertState } from '../../../shared/home-api'
import { useI18n } from '../locale'

const COPY = {
  en: {
    title: 'Converting old files to the new format',
    running: (left: number) => `${left.toLocaleString()} left. Originals are kept for 30 days.`,
    idle: 'Nothing is being converted right now.',
    done: (n: number) => `${n.toLocaleString()} converted`,
    failed: (n: number) => `${n.toLocaleString()} could not be converted`,
    now: 'Convert now',
  },
  vi: {
    title: 'Đang chuyển tệp cũ sang định dạng mới',
    running: (left: number) => `Còn ${left.toLocaleString()} tệp. Bản gốc được giữ 30 ngày.`,
    idle: 'Hiện không có tệp nào đang chuyển.',
    done: (n: number) => `Đã chuyển ${n.toLocaleString()} tệp`,
    failed: (n: number) => `${n.toLocaleString()} tệp không chuyển được`,
    now: 'Chuyển ngay',
  },
}

/** Progress of the background .xls/.doc/.ppt to .xlsx/.docx/.pptx conversion; hidden when there is nothing to show. */
export function LegacyConvertCard({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const c = lang === 'vi' ? COPY.vi : COPY.en
  const [state, setState] = useState<LegacyConvertState | null>(null)
  const peak = useRef(0)

  useEffect(() => {
    let alive = true
    const read = () =>
      void api
        .getLegacyConvertState?.()
        .then((next) => {
          if (!alive || !next) return
          peak.current = Math.max(peak.current, next.pending + next.converted)
          setState((prev) =>
            prev &&
            prev.running === next.running &&
            prev.pending === next.pending &&
            prev.converted === next.converted &&
            prev.failed === next.failed
              ? prev
              : next,
          )
        })
        .catch(() => undefined)
    read()
    const timer = setInterval(read, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api])

  if (
    !state ||
    (!state.running && state.pending === 0 && state.converted === 0 && state.failed === 0)
  )
    return null
  const total = Math.max(peak.current, state.pending + state.converted, 1)
  const share = Math.min(100, Math.round((state.converted / total) * 100))
  return (
    <section className="ixp-convert" aria-live="polite">
      <div className="ixp-convert-text">
        <strong>{c.title}</strong>
        <span>{state.pending > 0 ? c.running(state.pending) : c.idle}</span>
        <span
          className="ixp-bar"
          role="progressbar"
          aria-valuenow={share}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${share}%` }} />
        </span>
        <small>
          {c.done(state.converted)}
          {state.failed > 0 ? ` · ${c.failed(state.failed)}` : ''}
        </small>
      </div>
      {!state.running && state.pending > 0 && (
        <button type="button" className="idx-btn" onClick={() => void api.startLegacyConvert?.()}>
          {c.now}
        </button>
      )}
    </section>
  )
}
