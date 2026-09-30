# Memory for documents opened in GenOffice

Design specification; this feature is not enabled by the update-button change.

## User flow

Parents open documents as usual. GenOffice indexes content in the background
and refreshes the index after a successful save. A question in the AI panel
can find previously opened files by their contents, read the matching file,
and answer with a source reference and an Open file action. No indexing wizard
or sign-in prompt is shown when a document opens.

For example, a file named “Danh sách tháng 9.xlsx” contains a table of student
names, class 2/1 and phone numbers. “Tìm file có số điện thoại học sinh lớp 2/1”
must find this file from its table contents even though its title contains none
of those terms. A summary such as “school document” is insufficient.

## What to retain

- Persistent identity, current path, hash, modified time, extraction status and
  last opened time for every successfully opened local document. The collection
  survives the Recent list's size limit. Opening a folder does not enroll all its
  files.
- Compact extracted text split into addressable passages, preserving table
  headers, row context, page/slide/sheet locations and paragraph boundaries.
  Store the searchable text, not another original Word/PDF copy.
- Exact searchable terms and entities (names, class identifiers such as 2/1,
  numbers, contact information), plus embeddings for meaning-based retrieval.
  A short overview can help display results, but never replaces the content
  index.
- An explicit incomplete/indexing status. Large files, scans, unsupported text
  extraction or password protection must not silently become “no matching file”.

Retaining just a title or a few sampled paragraphs cannot guarantee that an
arbitrary detail buried elsewhere will be found. Compact text indexing is the
reliable baseline; embeddings need passage-level coverage too.

## Retrieval

Normalize Vietnamese accents and class variants (2/1, 2-1, lớp 2 1) without
conflating them with class 21. Combine exact keyword/number search with semantic
passage search, group matches by document, and return a small candidate set.
Fetch the original file again, verify freshness, read the relevant table or
passages, then answer using those contents. If candidates disagree, show the
sources or ask which year/class the user means. If a file moved, disappeared
or is unreadable, report that rather than inventing a contact number.

## Implementation direction

Reuse the existing `file-index` SQLite FTS and `file-parse` extraction where
appropriate. Add a distinct opened-document collection and chunk/location
schema; today's root-folder/Recent index is not this persistent collection.
Use a local embedding worker/model for background ingestion so opening a file
requires no paid API call. Serialize jobs and debounce saves to keep the editor
responsive. Reindex only changed files; retry failures in the background.

Expose provider-independent local tools to all editor AI panels for searching
this collection and reading source passages. Model generation uses the configured
AI provider only when a question is asked. Add a Settings control to pause
indexing, exclude a file or clear this collection.

Acceptance tests must include content-only matches, student tables with class
2/1, Vietnamese paraphrases, file edits/moves/deletion, a collection larger than
Recent retention, scanned PDFs and extraction failures. Return references and
never generate a phone number from a document overview alone.
