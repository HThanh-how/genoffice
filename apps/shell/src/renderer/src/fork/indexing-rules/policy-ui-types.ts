import type {
  IgnoreRule,
  IndexPolicyMode,
  IndexingPreset,
  IgnoreTestResult,
} from '../../../../shared/fork/document-index-api'

export type StudioView = 'overview' | 'rules' | 'ignore'

export type ActionFilter = 'all' | 'allow' | 'ignore'
export type SourceFilter = 'all' | 'user' | '.genofficeignore' | 'preset'
export type StateFilter = 'all' | 'enabled' | 'disabled'

export interface RuleFilters {
  search: string
  action: ActionFilter
  scope: string
  source: SourceFilter
  state: StateFilter
}

/**
 * The tester's four honest states. "error" covers every case where the
 * policy engine did not answer — it must never be rendered as "allowed".
 */
export type TestOutcome = 'allowed' | 'ignored' | 'unsupported' | 'error'

export interface TestDisplay {
  outcome: TestOutcome
  result: IgnoreTestResult | null
  indexed: boolean | null
  /**
   * The exact path/root the decision was computed for. A result is only ever
   * rendered while it still matches the current input, so an asynchronous
   * response from an earlier run can never be attributed to a new path.
   */
  path: string
  root: string
}

export type { IgnoreRule, IndexPolicyMode, IndexingPreset, IgnoreTestResult }
