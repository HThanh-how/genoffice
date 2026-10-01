import type { ActivityCopy } from '../indexing-activity-copy'
import type { IndexView } from '../indexing-activity-model'

/** Shown while the embedding model failed to load: cause, plain-language hint and a retry. */
export function ModelErrorBox({
  view,
  copy,
  busy,
  onRetry,
}: {
  view: IndexView
  copy: ActivityCopy
  busy: boolean
  onRetry: () => void
}) {
  if (view.kind !== 'model-error') return null
  return (
    <div className="indexing-activity-problem" role="alert">
      {view.modelError && (
        <p>
          <span>{copy.modelCause}</span> {view.modelError}
        </p>
      )}
      <p>{copy.reasons.model.hint}</p>
      <button type="button" className="indexing-activity-primary" disabled={busy} onClick={onRetry}>
        {busy ? copy.retrying : copy.tryAgain}
      </button>
    </div>
  )
}
