import { useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../../shared/home-api'
import type { StudioStrings } from './studio-strings'
import type { TestDisplay, TestOutcome } from './policy-ui-types'
import { classifyTestResult } from './policy-ui-state'
import { IconSearch } from './studio-icons'

export interface PathTesterProps {
  strings: StudioStrings
  api: HomeApi
  roots: string[]
}

function outcomeLabel(d: StudioStrings, outcome: TestOutcome): string {
  switch (outcome) {
    case 'allowed':
      return d.outcomeAllowed
    case 'ignored':
      return d.outcomeIgnored
    case 'unsupported':
      return d.outcomeUnsupported
    default:
      return d.outcomeError
  }
}

export function PathTester({ strings: d, api, roots }: PathTesterProps) {
  const [path, setPath] = useState('')
  const [root, setRoot] = useState('')
  const [display, setDisplay] = useState<TestDisplay | null>(null)
  const [busy, setBusy] = useState(false)

  const runSeqRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(
    () => () => {
      mountedRef.current = false
    },
    [],
  )

  /**
   * Every decision is tied to the path/root that produced it. As soon as the
   * submitted input changes, any result already on screen is stale and must
   * not be shown for the new path.
   */
  const isCurrent = (result: TestDisplay | null): boolean =>
    result !== null && result.path === path.trim() && result.root === root

  const run = async () => {
    const target = path.trim()
    if (!target) return
    const submittedRoot = root
    const seq = ++runSeqRef.current
    setBusy(true)
    setDisplay(null)
    try {
      const result = api.testIgnorePath
        ? await api.testIgnorePath(target, submittedRoot || undefined)
        : null
      const outcome = classifyTestResult(result)
      let indexed: boolean | null = null
      if (outcome === 'allowed' && api.searchIndexedFiles) {
        try {
          const hits = await api.searchIndexedFiles(target.split(/[\\/]/).pop() || target)
          const normalized = target.replace(/\\/g, '/').toLowerCase()
          indexed = (hits || []).some(
            (hit) => hit.path.replace(/\\/g, '/').toLowerCase() === normalized,
          )
        } catch {
          indexed = null
        }
      }
      // A slower, earlier run must not overwrite a newer one.
      if (!mountedRef.current || seq !== runSeqRef.current) return
      setDisplay({ outcome, result: result ?? null, indexed, path: target, root: submittedRoot })
    } catch {
      // An IPC failure is an explicit error state, never a silent "allowed".
      if (!mountedRef.current || seq !== runSeqRef.current) return
      setDisplay({
        outcome: 'error',
        result: null,
        indexed: null,
        path: target,
        root: submittedRoot,
      })
    } finally {
      if (mountedRef.current && seq === runSeqRef.current) setBusy(false)
    }
  }

  const shown = isCurrent(display) ? display : null

  return (
    <div className="ixr-tester">
      <form
        className="ixr-tester-form"
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <input
          id="ixr-tester-input"
          type="text"
          className="idx-input ixr-input"
          value={path}
          onChange={(event) => {
            setPath(event.target.value)
            setDisplay(null)
          }}
          placeholder={d.testerPlaceholder}
          aria-label={d.testerTitle}
        />
        {roots.length > 1 && (
          <select
            className="idx-input ixr-select"
            value={root}
            onChange={(event) => {
              setRoot(event.target.value)
              setDisplay(null)
            }}
            aria-label={d.testerRoot}
          >
            <option value="">{d.testerAuto}</option>
            {roots.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        )}
        <button type="submit" className="ixr-btn" disabled={busy || !path.trim()}>
          <IconSearch />
          <span>{busy ? d.testerChecking : d.testerCheck}</span>
        </button>
      </form>

      {shown && (
        <div className={`ixr-test-result outcome-${shown.outcome}`} role="status">
          <span className="ixr-outcome">{outcomeLabel(d, shown.outcome)}</span>
          {shown.outcome === 'error' && (
            <span className="ixr-test-detail">{d.outcomeErrorHint}</span>
          )}
          {shown.outcome !== 'error' && shown.result?.winningRule && (
            <span className="ixr-test-detail">
              <code>{shown.result.winningRule.pattern}</code>
              <span className="ixr-muted">
                {shown.result.explanation ?? shown.result.reason ?? ''}
              </span>
            </span>
          )}
          {shown.outcome === 'allowed' && shown.indexed !== null && (
            <span className="ixr-muted">{shown.indexed ? d.indexedYes : d.indexedNo}</span>
          )}
        </div>
      )}
    </div>
  )
}
