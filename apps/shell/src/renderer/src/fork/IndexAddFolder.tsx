import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  KnownSearchSource,
  KnownSearchSourceEntry,
} from '../../../shared/fork/document-index-api'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { TEXT, EN } from './index-dashboard-i18n'
import { IconPlus } from './index-icons'
import { IndexMenu, MenuItem, MenuSeparator } from './IndexMenu'

const COMMON: Array<{ id: KnownSearchSource; en: string; vi: string }> = [
  { id: 'documents', en: 'Documents', vi: 'Tài liệu' },
  { id: 'downloads', en: 'Downloads', vi: 'Tải về' },
  { id: 'desktop', en: 'Desktop', vi: 'Màn hình chính' },
]

/** Documents, Downloads and Desktop as one-tap switches; read only while someone is looking at them. */
export function useCommonPlaces(api: HomeApi, active: boolean, onChanged: () => void) {
  const [entries, setEntries] = useState<KnownSearchSourceEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const load = useCallback(async () => {
    try {
      const list = await api.getKnownSearchSources?.()
      if (alive.current && Array.isArray(list)) setEntries(list)
    } catch {
      /* the switches simply stay off */
    }
  }, [api])
  useEffect(() => {
    if (active) void load()
  }, [active, load])
  const toggle = async (id: KnownSearchSource, enabled: boolean) => {
    if (busy) return
    setBusy(id)
    try {
      await api.setKnownSearchSource?.(id, enabled)
    } catch {
      /* the refresh below shows the truth */
    } finally {
      await load()
      if (alive.current) setBusy(null)
      onChanged()
    }
  }
  return { entries, busy, toggle }
}

export interface AddFolderProps {
  api: HomeApi
  disabled?: boolean
  onChoose: () => void
  onChanged: () => void
}

export function AddFolderButton({ api, disabled, onChoose, onChanged }: AddFolderProps) {
  const { lang } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const places = useCommonPlaces(api, open, onChanged)
  return (
    <>
      <button
        type="button"
        ref={setAnchor}
        className="ix-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <IconPlus />
        {s.addFolder}
      </button>
      {open && (
        <IndexMenu anchor={anchor} onClose={() => setOpen(false)} width={256} label={s.addFolder}>
          <MenuItem
            onClick={() => {
              setOpen(false)
              onChoose()
            }}
          >
            {s.chooseFolder}
          </MenuItem>
          <MenuSeparator />
          <div className="ix-menu-label">{s.common}</div>
          {COMMON.map((place) => {
            const entry = places.entries.find((e) => e.id === place.id)
            const on = !!entry?.enabled
            return (
              <MenuItem
                key={place.id}
                checked={on}
                disabled={places.busy !== null}
                onClick={() => void places.toggle(place.id, !on)}
              >
                <span className="ix-menu-grow">{lang === 'vi' ? place.vi : place.en}</span>
                <span className="ix-menu-state">{on ? s.commonOn : s.commonOff}</span>
              </MenuItem>
            )
          })}
        </IndexMenu>
      )}
    </>
  )
}

/** First run: nothing is indexed, so the screen's one job is to pick a folder. */
export function IndexEmpty({ api, onChoose, onChanged, busy }: AddFolderProps & { busy: boolean }) {
  const { lang } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  const places = useCommonPlaces(api, true, onChanged)
  return (
    <section className="ix-empty" aria-label={s.emptyTitle}>
      <h2>{s.emptyTitle}</h2>
      <p>{s.emptyBody}</p>
      <button type="button" className="ix-btn is-primary" disabled={busy} onClick={onChoose}>
        <IconPlus />
        {s.chooseFolder}
      </button>
      <ul className="ix-empty-places" aria-label={s.common}>
        {COMMON.map((place) => {
          const entry = places.entries.find((e) => e.id === place.id)
          const on = !!entry?.enabled
          return (
            <li key={place.id}>
              <span className="ix-empty-place">
                <strong>{lang === 'vi' ? place.vi : place.en}</strong>
                {entry?.path && <span title={entry.path}>{entry.path}</span>}
              </span>
              <button
                type="button"
                className="ix-btn"
                aria-pressed={on}
                disabled={places.busy !== null}
                onClick={() => void places.toggle(place.id, !on)}
              >
                {on ? s.added : s.addShort}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
