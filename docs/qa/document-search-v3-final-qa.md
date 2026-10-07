# Document Search V3 final QA

Decision: **APPROVED TO MERGE**, after all final gates pass.

## Scope and provenance

- Production baseline: `c5c42f001f4ca42797d3d302fc39bc3e35a94865`.
- Integration baseline: `3702f6b1b0a673723e928197567927e933b51e66`, which adds only PATH-01/PATH-02 tests to the frozen baseline.
- Final repair changes only four test fixtures. No production code, dependencies, or lockfile changed.
- QA used an isolated worktree and dependencies installed from the baseline lockfile.
- The original working checkout and its untracked canary test were preserved.

## Fixture repairs

Four migration invocations omitted the now-required active embedding space and dimensions. The repaired tests supply the values matching their existing fixtures, allowing their migration and rollback assertions to exercise the intended paths. The verifier's valid-state fixture now supplies its three required FTS records. Assertions and production safeguards were preserved.

## Runner evidence

| Gate | Result |
| --- | --- |
| Document-memory architecture | PASS, exit 0 |
| Shell typecheck | PASS, exit 0 |
| English comments | PASS, exit 0 |
| Dependency licenses | PASS, exit 0 |
| Original 14 targeted suites | 14 files passed; 91 tests passed |
| Broader regression suites | 21 files passed; 130 tests passed |
| Final integration cutover suite, including both PATH cases | 1 file passed; 9 tests passed |
| Diff whitespace check | PASS |

The two regression runs overlap; their test counts must not be added as a unique-test total. Original failing results remain available: 86 passed and 5 failed, before the fixture repairs.

Broader coverage includes legacy vector provenance/migration, active-space corruption rejection, bootstrap, search parity, folder scan and queue order, diagnostics, progress, process-isolated maintenance, garbage collection, and IPC contracts.

## Real database canary

Only an offline clone of the existing database was migrated. The source DB and WAL retained identical SHA-256 hashes before and after the canary; no migration ran against the live database.

- Source database: 5,460,258,816 bytes, with WAL and SHM included in its snapshot.
- Migration: PASS; 29,476 documents and 845,208 chunks copied, 58 artifact documents dropped by retention policy.
- Migration wall time: 501,699 ms, approximately 8 minutes 22 seconds.
- Physical integrity, foreign keys, logical verification, bootstrap reopen, and store reopen: PASS.
- V3 database: 1,069,363,200 bytes. The V2 rollback backup was retained.
- Additional read-only sample: 100 distinct chunks retained exact text, location, document association, names, and paths; all had FTS records.

The source used legacy E5 vectors with 384 dimensions; absent saved profile settings, the active profile is F2 with 320 dimensions. Zero incompatible vectors were imported, as required by the provenance contract. Lexical text remains available; semantic search requires rebuilding vectors. The migrated database has 27,413 nonexcluded pending/text-only documents eligible for the existing startup poll/requeue mechanism. This is a functional migration pass, not a claim that semantic indexing has completed or that search relevance was benchmarked on every document.

## Evidence location

Local runner logs, exit codes, fixture diff report, canary results, hashes, and sample results are under `D:\HT\pve\builds\final-qa-c5c42f00`, including `repair-qa\REPORT.md`, `canary-result.json`, `canary-sample-result.json`, and `live-source-verification.json`. Private database contents are not committed to the repository.

Merge authorization was provided by the repository owner. Installation and live-database migration are outside this QA run.
