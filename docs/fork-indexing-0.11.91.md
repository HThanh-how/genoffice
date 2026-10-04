# Indexing reliability and interaction updates (0.11.91)

The Index page now reports progress across the entire registered library, rather than the
last scanned folder. Local extraction, vector work and remote Antigravity OCR have separate
status lanes. Queued vector documents are not displayed as actively processing.

## File actions and settings

- File actions acknowledge queue admission immediately, independently of the next status refresh.
- Expanded details refresh while open and preserve the last readable status on a failed refresh.
- Right-click menus and bulk actions use current per-file capabilities. Partial successes retain
  failed selections and report actual counts.
- Settings reads have bounded waits and explicit recovery controls. A mutation timeout reports
  an unknown outcome instead of automatically repeating a potentially destructive action.
- Failed embedding jobs retain their checkpoints and can be retried without rereading the source.

## OCR restart and error handling

Confirmed manual OCR queues and pending reindex handoffs are persisted. Returned OCR text is saved
before waiting for the quota refresh. Restarted work uses saved pages and resumes pending handoffs.
An in-flight provider response that never reached the app before termination cannot be recovered.

Exhausted or permanent OCR failures leave the manual queue instead of making unlimited paid retries.
A new confirmed request may clear a login/CLI availability halt after the user fixes it; it does
not erase provider quota/rate limits. Automatic reserve budgets and the 50% CPU thread ceiling
remain unchanged.

## Company drives and other unavailable sources

Configured roots are retained while disconnected. Name-index scans explicitly report whether the
inventory is complete. Unavailable roots, partial walks and generic stat failures never establish
that cached files were deleted. The last searchable content survives a failed refresh.

Content reconciliation also refuses a partial inventory. Confirming a missing source requires a
reachable volume/share root; extraction/verification failures on an unavailable source retain the
cached content index. A watcher whose events silently stop is reopened with capped backoff and
performs a catch-up reconciliation after recovery. Access to the original file still requires its
drive/share to be connected. Mounting at a different drive letter/path remains a different root.

## Validation

- Broad Shell suite: 1,509 passing tests, 9 skipped; the existing platform/fixture-dependent
  default-app, headless-export and legacy-doc suites were excluded from this local run.
- Subsequent scoped checks cover offline/reconnect, partial traversal, cached content retention,
  actual local deletion, per-file actions, settings and queue recovery.
- Browser checks cover dark/light themes, narrow layout, right-click positioning, repeated menu
  toggles, settings navigation and recovery from a status request that never resolves.
- Type checking, renderer theme/comment checks, license checking, lint and the production Shell
  build are checked locally. Windows/macOS installer packaging runs in GitHub Actions.

The Antigravity CLI version (for example 1.2.16) is independent of the GenOffice app version.
