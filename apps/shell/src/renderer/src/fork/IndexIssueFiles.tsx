import { IndexFileBrowser } from './IndexFileBrowser'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import type { IndexingNow } from '../../../shared/fork/document-index-api'

/** One shared interaction model for issues, waiting, activity and folder contents. */
export function IndexIssueFiles({
  api,
  reasons,
  count,
  onChanged,
  now = null,
}: {
  api: HomeApi
  reasons: readonly IndexIssueReason[]
  count: number
  onChanged: () => void
  now?: IndexingNow | null
}) {
  return (
    <IndexFileBrowser
      api={api}
      scope={{ reasons }}
      revision={count}
      now={now}
      onChanged={onChanged}
    />
  )
}
