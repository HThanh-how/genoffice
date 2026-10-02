import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexedFileHit } from '../../../shared/fork/document-index-api'
import type { Lang } from '@genoffice/i18n'
import { useI18n } from '../locale'
import { activityCopy } from '../indexing-activity-copy'
import { FileRow, fileWords, useFileActions } from './IndexFiles'

const EN = {
  none: 'No file in the index matches “{q}”.',
  hint: 'Only files GenOffice has been told to index are listed. Add the folder first if it is missing.',
  searching: 'Searching…',
}
const VI = {
  none: 'Không có tệp nào trong chỉ mục khớp “{q}”.',
  hint: 'Chỉ liệt kê các tệp GenOffice đã được cho phép index. Nếu thiếu, hãy thêm thư mục chứa nó trước.',
  searching: 'Đang tìm…',
}

/** Results of the "find a file in the index" box: any state, with the same row and log as the lists. */
export function IndexSearch({
  api,
  query,
  onChanged,
}: {
  api: HomeApi
  query: string
  onChanged: () => void
}) {
  const { lang } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const w = fileWords(lang)
  const copy = activityCopy(lang as Lang)
  const [hits, setHits] = useState<IndexedFileHit[] | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setHits(null)
    const timer = setTimeout(() => {
      api
        .searchIndexedFiles(query)
        .then((found) => {
          if (alive) setHits(found)
        })
        .catch(() => {
          if (alive) setHits([])
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, query, tick])

  const actions = useFileActions(
    api,
    (reason) => copy.reasons[reason].title,
    onChanged,
    () => setTick((n) => n + 1),
  )

  if (hits === null) return <p className="ixp-loading">{d.searching}</p>
  if (hits.length === 0)
    return (
      <div className="idx-empty">
        <p>{d.none.replace('{q}', query)}</p>
        <p className="idx-muted">{d.hint}</p>
      </div>
    )
  return (
    <div className="ixp">
      {actions.note && (
        <p className="ixp-note" role="status">
          {actions.note}
        </p>
      )}
      <section className="ixp-group is-open">
        <ul className="ixp-files ixp-files-flat">
          {hits.map((hit) => (
            <FileRow
              key={hit.id}
              item={hit}
              actions={actions}
              api={api}
              status={hit.reason ? (hit.error ?? copy.reasons[hit.reason].title) : w.okTag}
            />
          ))}
        </ul>
      </section>
    </div>
  )
}
