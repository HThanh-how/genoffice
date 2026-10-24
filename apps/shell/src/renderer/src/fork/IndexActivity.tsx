import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { indexV2Words } from '../i18n/strings-index-v2'
import { IndexCardHeading } from './IndexCard'
import { IndexFileBrowser } from './IndexFileBrowser'
import { IconChevron, IconClock } from './index-icons'
import type { FileItem } from './IndexFiles'

function RecentlyOpened({ api, onChanged }: { api: HomeApi; onChanged: () => void }) {
  const { lang } = useI18n()
  const w = indexV2Words(lang)
  const [items, setItems] = useState<FileItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let alive = true
    void api
      .recents({ limit: 10 })
      .then(async (result) =>
        Promise.all(
          (result.entries ?? []).map(async (entry, index) => {
            const hits = await api.searchIndexedFiles(entry.name)
            return {
              ...(hits.find((hit) => hit.id > 0 && hit.path === entry.path) ?? {
                id: -(index + 1),
                path: entry.path,
                name: entry.name,
                status: 'on-disk',
                mtimeMs: entry.mtimeMs,
              }),
              mtimeMs: entry.mtimeMs,
            }
          }),
        ),
      )
      .then((result) => {
        if (alive) {
          setItems(result)
          setFailed(false)
        }
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [api, reload])
  return failed ? (
    <p className="ix-note" role="status">
      {w.failed}{' '}
      <button type="button" className="ix-link" onClick={() => setReload((n) => n + 1)}>
        {w.retry}
      </button>
    </p>
  ) : items ? (
    <IndexFileBrowser api={api} fixedItems={items} onChanged={onChanged} />
  ) : (
    <p className="ix-note" role="status">
      {w.loading}
    </p>
  )
}

export function IndexActivity({
  api,
  onChanged,
  onViewAll,
}: {
  api: HomeApi
  onChanged: () => void
  onViewAll: () => void
}) {
  const { lang } = useI18n()
  const w = indexV2Words(lang)
  const [indexedOpen, setIndexedOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  return (
    <section className="ix-card ix-activity">
      <button
        type="button"
        className="ix-card-disclosure"
        aria-expanded={activityOpen}
        onClick={() => setActivityOpen((v) => !v)}
      >
        <IndexCardHeading title={w.activity} hint={w.activityHint} icon={<IconClock />} />
        <span className={`ix-chev${activityOpen ? ' is-open' : ''}`}>
          <IconChevron />
        </span>
      </button>
      {activityOpen && (
        <>
          <button
            type="button"
            className="ix-activity-row"
            aria-expanded={indexedOpen}
            onClick={() => setIndexedOpen((v) => !v)}
          >
            <strong>{w.recentlyIndexed}</strong>
            <span className={`ix-chev${indexedOpen ? ' is-open' : ''}`}>
              <IconChevron />
            </span>
          </button>
          {indexedOpen && (
            <IndexFileBrowser
              api={api}
              scope={{ sort: 'recent', descending: true }}
              onChanged={onChanged}
            />
          )}
          <button
            type="button"
            className="ix-activity-row"
            aria-expanded={recentOpen}
            onClick={() => setRecentOpen((v) => !v)}
          >
            <strong>{w.recents}</strong>
            <span className={`ix-chev${recentOpen ? ' is-open' : ''}`}>
              <IconChevron />
            </span>
          </button>
          {recentOpen && (
            <>
              <RecentlyOpened api={api} onChanged={onChanged} />
              <button type="button" className="ix-link ix-activity-home" onClick={onViewAll}>
                {w.viewAll}
              </button>
            </>
          )}
        </>
      )}
    </section>
  )
}
