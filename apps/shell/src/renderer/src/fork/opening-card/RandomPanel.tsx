import React, { useId, useMemo, useState } from 'react'
import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import {
  appsShuffling,
  groupName,
  randomCandidates,
  randomPoolFor,
} from '../../../../shared/opening-card-groups'
import type { OpeningPrefs, OpeningRandomPool } from '../../../../shared/opening-scenes-meta'
import { AppLogoStack } from './AppMarks'
import { TargetSwitch } from './TargetSwitch'
import { isShuffling, type ApplyScope } from './studio-logic'

const ALL_POOL: OpeningRandomPool = { groups: [], starredOnly: false }

interface RandomPanelProps {
  cards: readonly OpeningCardDefinition[]
  prefs: OpeningPrefs
  lang: string
  /** the groups that hold at least one card, in the order the gallery shows them */
  groupIds: readonly string[]
  /** turn random on (with this pool) or off for a target */
  onChange: (scope: ApplyScope, pool: OpeningRandomPool | null) => void
}

/**
 * Random mode: instead of one card, an app (or every app) plays a card drawn from a pool each time a
 * file opens. The pool is every card, or the chosen groups, and optionally only the starred ones.
 * Collapsed it is one line that says whether it is on and for what; the line stays visible so a
 * shuffling app is never a surprise.
 */
export function RandomPanel({
  cards,
  prefs,
  lang,
  groupIds,
  onChange,
}: RandomPanelProps): React.JSX.Element {
  const isVi = lang === 'vi'
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<ApplyScope>('all')
  const bodyId = useId()

  const shuffling = appsShuffling(prefs)
  const own = prefs.random?.[scope]
  const effectivePool: OpeningRandomPool | undefined =
    scope === 'all' ? prefs.random?.all : randomPoolFor(prefs, scope)
  const on = scope === 'all' ? Boolean(prefs.random?.all) : isShuffling(prefs, scope)
  const pool = own ?? effectivePool ?? ALL_POOL
  const count = useMemo(() => randomCandidates(cards, prefs, pool).length, [cards, prefs, pool])

  const poolText = (p: OpeningRandomPool): string => {
    const names = p.groups.length
      ? p.groups.map((id) => groupName(id, prefs, lang)).join(', ')
      : isVi
        ? 'mọi thẻ'
        : 'all cards'
    return p.starredOnly ? `${names} · ${isVi ? 'chỉ thẻ gắn sao' : 'starred only'}` : names
  }

  // The one line that says how it is set: every app, or which ones, and from what
  const summary = (() => {
    if (shuffling.length === 0) return isVi ? 'Đang tắt' : 'Off'
    const all = prefs.random?.all
    const apps = (
      <AppLogoStack apps={shuffling} isVi={isVi} size={16} max={4} />
    ) as React.ReactNode
    const what = all && shuffling.length === 6 ? poolText(all) : ''
    return (
      <>
        <span className="ocs-random-on">{isVi ? 'Đang bật' : 'On'}</span>
        {apps}
        {what && <span className="ocs-random-what">{what}</span>}
      </>
    )
  })()

  const toggleGroup = (id: string) => {
    const has = pool.groups.includes(id)
    onChange(scope, {
      ...pool,
      groups: has ? pool.groups.filter((g) => g !== id) : [...pool.groups, id],
    })
  }

  return (
    <section className={`ocs-random${shuffling.length > 0 ? ' is-on' : ''}`}>
      <button
        type="button"
        className="ocs-random-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M1.5 4.5h2.2c1.6 0 2.4.8 3.3 2.2l1.2 1.8c.9 1.4 1.7 2.2 3.3 2.2h3M1.5 11.5h2.2c.9 0 1.6-.3 2.1-.8M9.3 5.3c.5-.5 1.2-.8 2-.8h3M12.5 2.5l2 2-2 2M12.5 9.5l2 2-2 2" />
        </svg>
        <span className="ocs-random-title">{isVi ? 'Thẻ ngẫu nhiên' : 'Random card'}</span>
        <span className="ocs-random-summary">{summary}</span>
        <svg
          className={`ocs-random-chevron${open ? ' is-open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="ocs-random-body" id={bodyId}>
          <p className="ocs-random-hint">
            {isVi
              ? 'Mỗi lần mở tệp, ứng dụng chọn một thẻ khác trong nhóm bạn chọn.'
              : 'Each time a file opens, the app plays a different card from the pool you choose.'}
          </p>
          <div className="ocs-random-row">
            <TargetSwitch value={scope} onChange={setScope} isVi={isVi} />
            <button
              type="button"
              role="switch"
              aria-checked={on}
              className={`ocs-switch${on ? ' is-on' : ''}`}
              onClick={() => onChange(scope, on ? null : { ...pool })}
            >
              <span className="ocs-switch-track" aria-hidden="true">
                <span className="ocs-switch-thumb" />
              </span>
              <span>
                {on
                  ? isVi
                    ? 'Đang bật cho mục này'
                    : 'On for this target'
                  : isVi
                    ? 'Bật cho mục này'
                    : 'Turn on for this target'}
              </span>
            </button>
          </div>

          <div
            className={`ocs-random-pool${on ? '' : ' is-idle'}`}
            role="group"
            aria-label={isVi ? 'Chọn nhóm' : 'Pool'}
          >
            <button
              type="button"
              className={`ocs-chip${pool.groups.length === 0 ? ' is-on' : ''}`}
              aria-pressed={pool.groups.length === 0}
              onClick={() => onChange(scope, { ...pool, groups: [] })}
            >
              {isVi ? 'Tất cả thẻ' : 'All cards'}
            </button>
            {groupIds.map((id) => (
              <button
                key={id}
                type="button"
                className={`ocs-chip${pool.groups.includes(id) ? ' is-on' : ''}`}
                aria-pressed={pool.groups.includes(id)}
                onClick={() => toggleGroup(id)}
              >
                {groupName(id, prefs, lang)}
              </button>
            ))}
            <button
              type="button"
              className={`ocs-chip ocs-chip-star${pool.starredOnly ? ' is-on' : ''}`}
              aria-pressed={pool.starredOnly}
              onClick={() => onChange(scope, { ...pool, starredOnly: !pool.starredOnly })}
            >
              ★ {isVi ? 'Chỉ thẻ gắn sao' : 'Starred only'}
            </button>
          </div>
          <p className="ocs-random-count" role="status">
            {count === 0
              ? isVi
                ? 'Không có thẻ nào trong nhóm này; ứng dụng sẽ dùng thẻ cố định của nó.'
                : 'No cards in this pool; the app falls back to its fixed card.'
              : isVi
                ? `${count} thẻ trong nhóm`
                : `${count} ${count === 1 ? 'card' : 'cards'} in the pool`}
            {count === 1 &&
              (isVi ? ' (không đổi giữa các lần mở)' : ' (nothing to alternate with)')}
          </p>
        </div>
      )}
    </section>
  )
}
