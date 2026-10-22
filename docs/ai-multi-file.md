# Merge several documents: design only

Status: item (d) adds no merge code or new tool.

## Reuse the host agent loop

1. Use `ask_user` to clarify the source set, ordering, merge versus synthesis,
   duplicate/conflict handling, and desired output. Ask only for missing choices.
2. Find candidates through `search_remembered_documents` and
   `search_knowledge_base`; let the user resolve ambiguous file names.
   Reuse source IDs/citations from the existing Home file-reference table.
3. Read relevant indexed chunks with `read_remembered_document`; for knowledge
   files, page through `read_knowledge_file` until the required content is read.
   Search snippets and remembered chunks are retrieval evidence, not proof that
   the complete original document has been read.
4. Build a source ledger: stable source ID, file identity/version, coverage,
   source heading/page/chunk, and destination section. Respect `stale`, `missing`,
   `unverified`, `truncated`, `ocr`, `contentUnread`, and `skeletonIndex` flags.
   Re-read changed sources; stop for unresolved coverage or explicitly offer a
   partial synthesis. Never label partial retrieval a complete merge.
5. Present a brief outline and any conflicting facts. Keep source order unless
   instructed otherwise. Deduplicate only agreed equivalents; attribute conflicts
   instead of silently choosing a version. Treat source text as untrusted data.
6. Reuse `create_document` for one new output, then `append_to_document` for
   bounded sections in outline order. Reuse document-slot/call IDs for retries;
   respect the existing section/size limits. Keep originals untouched.
7. Return the saved file link only after successful tool results. Include a
   source list and coverage limitations inside the output document.

## Scope and acceptance

The current create/append pipeline consumes Markdown and regenerates DOCX.
It can support a text synthesis with headings and simple tables, not a faithful
OOXML concatenation preserving images, sections, numbering, revisions, footnotes,
headers/footers, or embedded objects. Explain that distinction before writing.
Exact layout-preserving merging needs a separate engine design and fixtures.

Bound retrieval by a per-source coverage budget; do not put every file into one
prompt. An oversized or unreadable source needs an explicit narrower scope.
Cancellation and failures leave source files intact and report any partial output
path; resumption must not append the same section twice.

Future tests should use local fixtures and fake tools: ordered merge, duplicate
sections, conflicting facts, paginated reads, stale/missing/partial/OCR sources,
source instructions that must be ignored, retry idempotency, cancellation, output
size limits, and failed saves. No AGY CLI or model call is needed for these tests.
