# Index v2 feature parity

Reference: `v0.12.30`; baseline: Release 0.12.33 (`ccab6f9a`).
Inventory completed before implementation. Sources: IndexDashboard, IndexNav,
IndexOverview, TodoTab, IndexProblems, IndexFiles, IndexedFolders, RecentFiles,
IndexSettingsTab and their models/styles at the reference tag. Also reviewed
81aaa02e, 0427e6be, bf63cfb9 and the design/index-B and design/index-C dashboards.

The screen answers: **Are my documents searchable, and what needs my help?**
Its objects are enrolled roots, document metadata, queue entries, reason groups,
scan runs, ignore rules, OCR jobs and the local index settings. Counts come from
the existing snapshot. Files are read only when a disclosure opens. Ordinary
usage is a glance; recovery can involve thousands of files and hundreds of roots.
The product-specific element is the searchable / waiting / needs-you pipeline.
The visual reference is GenOffice's Appearance card, using its existing semantic
tokens and generic Settings classes. No invented activity or success figures.

## Capability matrix

“A regression” means absent or reduced in the default 0.12.33 Index experience,
even if the component survived as unreachable source code. “Kept” means reachable
already, not that the presentation is unchanged. Locations below describe the
v2 implementation target and are checked against the final implementation below.

| Reference capability                                                      | A regression         | v2 location / interaction                                                                                                               |
| ------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Overview / Sources / Issues / Settings navigation                         | Tabs removed         | Intentional replacement: one page with status, attention, folders, activity and folded Rules & settings; no capability depends on a tab |
| Back; Ctrl/Cmd+F to Home search                                           | Kept                 | Header / existing search shortcut                                                                                                       |
| Searchable, Waiting, Need-you counts                                      | Reduced to prose     | Status facts, sourced from the same summary as the lists                                                                                |
| Progress; rolling ETA; current file and page/chunk progress               | Kept                 | Single status header; live file detail                                                                                                  |
| Global pause/resume; automatic hold reasons and battery saver explanation | Kept                 | Status primary control and reason                                                                                                       |
| Model download, retry model, stale/error/loading states                   | Kept                 | Status header and local retry notices                                                                                                   |
| Add folder; common sources                                                | Kept                 | Header / empty state add-folder menu                                                                                                    |
| Scan all; stop scan                                                       | Kept                 | Header overflow                                                                                                                         |
| Flat per-folder list, file counts and partial progress                    | Kept                 | Folders card                                                                                                                            |
| Search folders by name/path                                               | Only 8+ roots        | Folder toolbar, available for small lists too                                                                                           |
| Folder priority / read first                                              | Kept                 | Folder overflow and detail actions                                                                                                      |
| Open folder in file manager; remove registered root                       | Kept                 | Folder overflow and detail actions; removal confirmation retained                                                                       |
| Last scan / reconciliation, scan errors, run history                      | Only overflow        | Folder detail disclosure                                                                                                                |
| Root unavailable/offline                                                  | Kept                 | Neutral folder state, offline-since detail and source recheck                                                                           |
| Folder contents / metadata                                                | Missing              | Folder detail → shared file browser                                                                                                     |
| Folder sort/group controls                                                | Missing              | Compact filter menu: name/count/size/recent/status; adjacent groups by status                                                           |
| Short readable attention categories                                       | Kept                 | Attention card; group Try again retained                                                                                                |
| All issue reasons and subgroups                                           | Reduced              | Expand category; reason filter in file toolbar                                                                                          |
| Expand all / Collapse all reason groups                                   | Missing              | Attention toolbar                                                                                                                       |
| Search issue names/paths                                                  | Missing              | File toolbar; filtered at the reader                                                                                                    |
| Sort queue/name/folder/type/progress/status/connection; reverse order     | Missing              | File filter menu; original view orders retained                                                                                         |
| Group reason/folder/type/none                                             | Missing              | File filter menu                                                                                                                        |
| Waiting queue drill-down                                                  | Exists via old panel | Folded Waiting disclosure using the same file browser                                                                                   |
| Skipped on purpose / no text / empty / too large / unsupported / password | Kept                 | Quiet skipped disclosure with all reasons accessible                                                                                    |
| Legacy Office conversion status, start and failure counts                 | Kept                 | Attention conversion row                                                                                                                |
| File icon, name, full path, plain-language reason                         | Reduced              | Shared selectable file row and detail                                                                                                   |
| File click expands details; chevron                                       | Missing              | Consistent detail panel in every file list; chevron opens it                                                                            |
| File size, modified time, update time, existence                          | Missing              | Lazy detail facts                                                                                                                       |
| Pipeline steps, truncation, model, chunk progress                         | Missing              | Lazy detail / technical log                                                                                                             |
| OCR pages, characters and model                                           | Missing              | Lazy detail facts                                                                                                                       |
| Storage importance override and suggestion                                | Missing              | Detail importance control                                                                                                               |
| Open file in app                                                          | Kept                 | Detail action; file row selection does not launch it                                                                                    |
| Show file in folder                                                       | Kept                 | Detail action and bulk show-first                                                                                                       |
| Retry/read again/read first                                               | Reduced              | Detail action and bulk retry                                                                                                            |
| Manual cloud OCR, consent and enqueue feedback                            | Reduced              | Detail / bulk OCR; original consent retained                                                                                            |
| Stop reading; read later                                                  | Missing              | Detail / bulk secondary actions                                                                                                         |
| Exclude file / remove from index (original files preserved)               | Missing              | Separate ignore-rule exclusion and existing remove-from-index action                                                                    |
| Copy path; copy filename; copy diagnostic log                             | Missing              | Detail actions / bulk copy paths                                                                                                        |
| Move selected original files to Trash, with confirmation                  | Missing              | Bulk secondary actions; destructive confirmation retained                                                                               |
| Checkbox; Ctrl/Cmd toggle; Shift range                                    | Missing              | Shared file rows, keyboard and pointer selection                                                                                        |
| Select shown; select group; clear selection                               | Missing              | Select shown/subgroup rows, or all matching files in the entire filtered category through bounded keyset pages                          |
| Bulk retry, OCR, defer, stop, copy, exclude, Trash                        | Missing              | Sticky selection bar, only when selected                                                                                                |
| Recently opened files and View all on Home                                | Missing              | Folded Recent files disclosure; shared detail plus Home link                                                                            |
| Recently indexed activity                                                 | Missing              | Folded Recently indexed disclosure ordered by index update                                                                              |
| Indexing effort, automatic pauses, CPU share                              | Kept                 | Rules & settings → Running in background                                                                                                |
| PDF pages                                                                 | Kept                 | Rules & settings → PDF pages                                                                                                            |
| Rules, scopes, allowlist, presets, path tester                            | Kept                 | Rules & settings → Ignore rules                                                                                                         |
| Read/edit/save .genofficeignore, conflict/validation feedback             | Kept                 | Existing rules studio, per-root editor                                                                                                  |
| OCR options, quotas, model and reserve floors                             | Kept                 | Rules & settings → Advanced reading & search                                                                                            |
| Embedding profile, diagnostics, Everything integration                    | Kept                 | Same folded settings area                                                                                                               |
| Database location/move/restart, storage budget, backup/compaction         | Kept                 | Same folded settings area                                                                                                               |
| Clear index content with original files/exclusions preserved              | Kept                 | Settings danger row; confirmation retained                                                                                              |
| First run; loading; failure/retry; narrow and dark layouts                | Kept                 | Every section retains its frame and local feedback                                                                                      |

No reference capability is intentionally deleted. The four tabs are a duplicated
navigation structure, replaced by disclosures. Metadata that was never persisted
must read “Not recorded”, never a fabricated timestamp, attempt count or rotation.
Right-click and Shift+F10 now open the same detail panel's More actions. The saved
issue sort/group/reverse preferences retain `genoffice.index.todo.view`; queries
and selections are temporary. Files opened without a registered folder remain
reachable. The setup screen is reserved for a genuinely empty, successful read.

Per-folder pause is new: it persists in the manifest, stops discovery/watching,
holds queued extraction and vector work, and skips queued local/cloud OCR without
recording failed attempts. Resume wakes the existing scheduler. Work already in
progress may finish. Pause intent is separate from source availability.

The old transient green completion rows are represented by operation feedback
and the next snapshot's real status. Redundant status prose counts were removed;
searchable/total, waiting and needs-you appear once in the header facts. Discovery
stays indeterminate; reading gets an ETA only after sufficient rolling samples.

## Implemented design and data path

One status header, a short attention list, and a flat folder list remain the
default. Generic `set-group-*` classes from Settings provide its tinted icon
tile, bold title and muted subtitle. Index cards have 16px corners and hairline
rows. SettingsModal.tsx and settings.css were not edited.

The design skill's initial editorial-greeting direction conflicted with the
approved A layout; it was redrawn as achromatic-ledger with GenOffice's palette
and typography retained. Tinted header icons follow the explicit Appearance
reference. No tokens or renderer color literals were added.

The same file browser serves issues, waiting, recent files and folder contents:
checkboxes, Ctrl/Cmd toggle, Shift range, arrows/Home/End, Enter, Space and Escape.
Details sit beside the list at wide widths and replace it in narrow windows.
The sticky bulk bar exists only for a nonempty selection. Search/filter/sort run
before database paging; the attention toolbar searches across categories. Recent
files and activity share one folded card; Rules & settings is separate.

The snapshot remains the clock. Converter and selected-file detail refreshes
use that cadence, with no new polling loop. Folder identity sharing, stable
callbacks and a shared idle progress result avoid unchanged row renders. The
existing windowing helper serves folders and file windows. A bounded folder
scroller keeps 320 roots from burying activity and settings.

`getIndexBrowserPage` returns at most 100 metadata records, counts, bytes and an
ID boundary. Filtering/sorting/counts, detail SQL and group retry ID enumeration
run in the existing reader worker in production. Detail is read after selection
and released on close. “Select all matching” walks bounded keyset pages, so
mutating matches does not skip later files or include newly added files.
The captured ID boundary excludes later arrivals; filters are evaluated against
current database state when the action runs, rather than retaining a 50k-ID
renderer snapshot. A file that stops matching before execution is skipped.
Subgroup/“select shown” controls operate on the loaded page; complete matching
categories can be selected explicitly. Full-folder selection is also available
from that folder's contents. New copy has en/vi/zh/zh-TW shards; other locales
keep the existing English fallback.

## Measurements

Fixture: 320 folders / 50,000 synthetic metadata rows. The reader comparison uses
one SQLite database and 100 permission-issue files, ten measured runs after warmup,
with the reference reader from v0.12.33. React measurements use both actual
dashboards in the same 1440 × 1000 development-browser harness and ten unchanged
snapshot refreshes after warmup. These are not production Electron timings.
Reader timing invokes both reader implementations directly in Node and measures
their CPU work; worker dispatch and IPC transport latency are excluded. The new
implementation is dispatched to the existing status worker in the application.

| Measure                                            |            Before |                     After |
| -------------------------------------------------- | ----------------: | ------------------------: |
| Read 100 issue rows, median                        | 297.28 ms on main | 78.52 ms in reader worker |
| Requests for those 100 rows                        |                10 |                         1 |
| Metadata response bytes for 100 rows               |            21,924 |                    27,959 |
| Unchanged React refresh, median                    |          12.10 ms |                   3.60 ms |
| Initial React commit, one indicative sample        |           7.60 ms |                   8.50 ms |
| Mounted folder rows near the initial viewport      |                20 |                        11 |
| Initial synthetic snapshot + folder metadata bytes |           131,752 |                   131,752 |

The richer window is larger because it restores progress and includes size/update
metadata; requests and reader CPU cost fall. Serializing the whole fixture's
50,000 metadata rows would take 8,511,683 bytes; that table is never sent to the
renderer. This is a size comparison, not a claim that A sent the entire table.
Raw results are kept in `.task/index-v2/reader-perf.json` and
`.task/index-v2/render-perf.json`.

## Visual verification

Disk fixture: 100 workspace folders, 300 small Markdown documents and five
deliberately invalid PDFs. The larger case uses 50,000 seeded metadata rows.
No real profile or documents were used.

The first review found an overlong folder page and actions below too much detail.
The second bounded the scroller and moved actions above metadata. The final
review removed inner list-card borders, consolidated activity, restored global
problem search, stacked settings descriptions and removed repeated status counts.
The rubric covers clutter, harmony with Appearance, hierarchy, discoverability,
honest states and keyboard/narrow-layout usability.

The screenshot harness uses actual renderer components with a synthetic API and
fresh browser contexts. Chrome CDP captures wide/narrow light/dark states, plus a
tablet detail view and an ETA based on real rolling samples. The scripted pass
checks horizontal overflow and browser page errors. Screenshot paths and final
check results are recorded below.

Final review also caught and corrected narrow settings-description clipping and
virtual-list Home-key focus loss. Focus now waits for the requested row to mount;
collapsed groups are omitted from arrow-key navigation. Browser checks passed
Home/End across virtual windows, arrows, Enter, Space, Escape and global problem
search. Fresh selected-file details replace stale list metadata. Known offline
roots use cached detail metadata without attempting filesystem stat.

The skill inspector was attempted with `--app --allow icon-chips`; it failed with
`CDP timeout: Page.enable`. Its written rules were applied manually.

## Native verification limitation and risks

The managed command policy rejected the initial hidden Electron launch. A safer
launcher validated a brand-new worktree-local GENOFFICE_USER_DATA and disabled
all common sources. Electron started, then exited before loading the app with
this runtime error:

> Sandboxed processes cannot read the Electron installation: its ACL has an AppContainer package SID but no ALL APPLICATION PACKAGES entry.

No ACL or sandbox settings were changed. Native Open/Reveal/Trash, a live OCR
provider and a full packaged/preload run remain unverified. UI/CDP screenshots
use the renderer harness; worker/IPC/actions are covered by targeted tests. Repeat
the isolated Electron run in a normal development environment before release.
Cold per-root aggregate warmup was not profiled in native Electron.

General read attempt history and rotation correction are not persisted by the
current schema and display “Not recorded”. Available local OCR failure counts,
attempt times, source/model/pages, file size and modified time are shown. Files
not yet indexed retain their known recent-file modified time and mark unknown
index metadata honestly. Existing rule precedence and limits still apply: 500
custom rules and the existing 2,000-file manual OCR queue. Bulk failures refresh
the view even after a partially completed batch.

## Final verification record

- `npx tsc --noEmit` in apps/shell: passed.
- Targeted Vitest: 30 files passed, 319 tests passed, one opt-in real-model
  integration test skipped. Includes windowing/model, attention/file interaction,
  dictionary parity, reader/IPC, folder scan/pause, OCR and queue/embedding tests.
- After the last renderer adjustment: eight affected test files / 55 tests passed.
- `npm run build` in apps/shell: passed; existing bundle/export warnings remain.
- `npm run lint`: passed with zero errors and 16 existing warnings outside this
  change. Prettier check passed for every intended changed file.
- Theme-color and document-memory architecture checks: passed. Manager is 500
  lines, document-index IPC 237, IndexDashboard 248, all within their gates.
- `git diff --check`: passed. Scratch source/helper files and the seeded database,
  folders, archived baseline and isolated profile were removed after verification.

Local artifacts retained outside the commit under
`D:/genoffice-codex-15/.task/index-v2/`:

- `screens/manifest.md` and `screens/manifest.json`: all 79 absolute screenshot
  paths. Final images are `screens/final/<state>-<width>-<theme>.png`; states are
  ready, scanning, paused, empty, offline, offline-detail, 320-folders,
  320-folders-end, issues-expanded, file-detail, multi-select, select-all,
  folder-detail, folder-contents, waiting, recently-indexed, recently-opened and
  rules-settings. Each has wide/narrow and light/dark variants. Extra captures:
  file-detail-tablet, working-eta-wide-light, global-search-wide-light,
  skipped-wide-light and locale-vi/zh/zh-TW-wide-light.
- `screens/review-*.png`, `round1.png` and the earlier round captures document
  visual iteration. Final settings captures supersede the contact-sheet versions
  for description wrapping. All final settings descriptions were also checked
  for clipping programmatically.
- `visual-errors.json`: no browser page errors or horizontal overflow.
- `interaction-qa.json`: successful browser keyboard/search checks and sampled
  ETA. `reader-perf.json` / `render-perf.json`: raw measurements.
- `tests.txt`, `final-ui-tests.txt`, `tsc.txt`, `build.txt`, `theme.txt`,
  `architecture.txt`, `lint.txt`, `format.txt`: check outputs.
- `changed-files.md`: complete list of the 60 intended changed files. Main areas:
  shared Index browser/card/detail/activity components and styles; existing Index
  status/folder/attention/settings integration; reader-worker IPC and bounded
  queries; persistent folder pause and queue eligibility; en/vi/zh/zh-TW copy;
  regression tests and this parity matrix. SettingsModal.tsx and settings.css
  remain unchanged. No commit was made.
