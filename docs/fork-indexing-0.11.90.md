# Indexing and quota sharing in 0.11.90

Names and complete folder paths are made searchable before content extraction. Name matching folds accents and case, combines words across the filename and parent folders, and ranks complete matches ahead of partial and prefix matches. Joined names remain searchable. Unchanged files retain their extracted content; interrupted pending files resume on a later scan.

Content extraction and vector generation remain local. Antigravity performs OCR remotely; the app prepares page images and stores the returned text locally. The embedding thread ceiling has not been increased. The separate text extraction queue now observes the existing pause and CPU duty-cycle policy. That thread ceiling is not a guarantee that total process CPU usage can never exceed 50% momentarily.

## Automatic OCR policy

Provider reset timestamps define both windows. They are not calendar weeks. Weekly budget days are 24-hour slices beginning at the provider's seven-day cycle start.

| Elapsed hour in the five-hour window | Account quota kept available |
| ------------------------------------ | ---------------------------- |
| 1                                    | 80%                          |
| 2                                    | 60%                          |
| 3                                    | 40%                          |
| 4                                    | 20%                          |
| 5                                    | 20%                          |

With the default daily allowance of 12 percentage points of total weekly quota:

| Day in the provider weekly cycle | Account weekly quota kept available |
| -------------------------------- | ----------------------------------- |
| 1                                | 88%                                 |
| 2                                | 76%                                 |
| 3                                | 64%                                 |
| 4                                | 52%                                 |
| 5                                | 40%                                 |
| 6                                | 28%                                 |
| 7                                | 16%                                 |

Both reserve rules apply together. A two-point start margin prevents repeated starts at a boundary. Automatic OCR also tracks its own measured weekly consumption against the daily allowance. Remaining quota is account-wide, so usage by other people affects whether OCR is allowed. The durable consumption ledger is local to this installation, not an atomic reservation shared by every computer.

Quota is measured before and after automatic requests. Unknown windows or unobserved charges stop further automatic requests. Delayed updates retain separate baselines for each bucket across app restarts. Future reset timestamp jitter does not grant a new allowance. Because providers report usage after a request and can update it late, the final request can cross a threshold; the app does not guarantee an exact hard account-wide cap.

Manual OCR requires confirmation and bypasses GenOffice's budgets, reserves and daily file cap. The Unlimited automatic mode also bypasses these limits. Both still obey provider limits and authentication; unlimited automatic mode retains device power/idle gates and failure backoff. New installations have no PDF-count cap; previously configured caps remain visible and can be changed.

## Progress and recovery

Todo has consistent row/context and bulk actions: prioritize/retry, OCR, defer, stop, copy paths, exclude and trash. OCR admission returns immediately. Mutation timeouts preserve selection and report an unknown outcome rather than automatically repeating a potentially completed action. Only successfully trashed files are removed from recent/starred lists.

Progress distinguishes folder scanning, files processed, passages prepared, OCR stages, device pause and quota waits. Completed empty files are not double-counted. ETA is hidden when its evidence is stale or the phase changes; passage throughput reveals work within large files. Folder rows expose processed/waiting/problem and passage counts.

A timed-out native indexing operation retires its worker before more work is admitted; late messages from the retired worker are ignored. PDF rendering, provider OCR and final indexing have deadlines and cancellation. Mixed PDFs skip pages that already have a text layer.

## Validation

- Shell suite: 1,478 tests passed and 9 skipped; excludes the unchanged platform-specific default-app/headless-export tests and legacy DOC tests whose original local fixtures were moved by the user.
- AI provider suite: 624 passed and 1 skipped.
- All workspace typechecks passed; shell typecheck repeated after integration.
- Production shell build and self-contained preload verification passed.
- Source lint, formatting, semantic-color and English-comment checks passed.
- Browser interaction checks covered dark/light and narrow layouts, immediate manual OCR admission, Unlimited confirmation/restoration, and recovery from a hung status request.
- The complete local installer build stops at the missing Rust toolchain. Windows/macOS installer workflows provide their own toolchains. No upgraded remote-machine smoke test has been performed for this version.
