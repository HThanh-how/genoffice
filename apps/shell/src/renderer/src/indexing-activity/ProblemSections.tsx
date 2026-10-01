import type { Lang } from '@genoffice/i18n'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { FolderScanStatus } from '../../../main/document-memory/folder-scan'
import type { ActivityCopy } from '../indexing-activity-copy'
import { formatCount, type ActionResult, type Words } from './format'
import { IssueGroup } from './IssueGroup'

type Group = IndexIssueSummary['groups'][number]

/** "Needs attention" (problem groups plus scan errors) and "Skipped" (informational groups). */
export function ProblemSections({
  api,
  folder,
  attentionGroups,
  skippedGroups,
  scanErrors,
  lang,
  copy,
  words,
  onChanged,
  onRetryAll,
}: {
  api: HomeApi
  folder: FolderScanStatus
  attentionGroups: Group[]
  skippedGroups: Group[]
  scanErrors: number
  lang: Lang
  copy: ActivityCopy
  words: Words
  onChanged: () => void
  onRetryAll: (reason: IndexIssueReason) => Promise<ActionResult>
}) {
  const renderGroup = (group: Group) => (
    <IssueGroup
      key={group.reason}
      api={api}
      root={folder.root!}
      reason={group.reason}
      count={group.count}
      lang={lang}
      copy={copy}
      words={words}
      onChanged={onChanged}
      onRetryAll={onRetryAll}
    />
  )
  return (
    <>
      {(attentionGroups.length > 0 || scanErrors > 0) && (
        <section className="indexing-activity-section" aria-label={copy.needsAttention}>
          <h3>{copy.needsAttention}</h3>
          {attentionGroups.map(renderGroup)}
          {scanErrors > 0 && (
            <div className="indexing-activity-group is-static">
              <div className="indexing-activity-group-head">
                <span>{copy.scanErrorsTitle}</span>
                <strong>{formatCount(scanErrors, lang)}</strong>
              </div>
              <p>{copy.scanErrorsHint}</p>
              {folder.lastError && (
                <details className="indexing-activity-details">
                  <summary>{copy.details}</summary>
                  <code>{folder.lastError}</code>
                </details>
              )}
            </div>
          )}
        </section>
      )}
      {skippedGroups.length > 0 && (
        <section className="indexing-activity-section" aria-label={copy.skipped}>
          <h3>{copy.skipped}</h3>
          {skippedGroups.map(renderGroup)}
        </section>
      )}
    </>
  )
}
