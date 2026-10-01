# Opened document memory

GenOffice automatically enrolls saved documents when the user opens them, and refreshes their content after saves. It does not crawl an entire drive. The persistent enrollment list survives removal from Recent.

## Storage and retrieval

- SQLite database: Electron userData / `document-memory.db` (macOS: `~/Library/Application Support/GenOffice/document-memory.db`). Original documents stay at their existing paths.
- Readable paragraphs and table contents are split into overlapping chunks, including content at the end of large documents. Each chunk has its source path and an ordinal location; page numbers are not invented.
- Local multilingual E5-small ONNX embeddings: 384 dimensions, quantized CPU model pinned to revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`. First use downloads the model/tokenizer from Hugging Face into `document-memory-models`; later uses the local cache. No embedding API key is required. The 118 MB ONNX file is verified with its published SHA-256.
- Hybrid retrieval combines Vietnamese accent-insensitive SQLite FTS5 with cosine vector ranking using reciprocal rank fusion. Extraction, model inference and vector scans run in a background worker.
- AI tools are available in Docs, Sheets, Slides, PDF, Markdown and HTML. The assistant searches remembered document contents, verifies the current source before returning facts, cites the file and chunk, and can open the matched source document.
- Local indexing sends no document content to an embedding service. Retrieved excerpts used to answer a question are supplied to the AI provider already configured for that conversation.

## Lifecycle and controls

Each embedding batch is committed independently. If the application closes or loses power, the next launch automatically resumes pending files and starts from the first missing vector for unchanged files. Completed chunk IDs and vectors are retained; only an unfinished batch needs recomputation. Pending work is ordered by the latest explicit open or file modification; opening a waiting file moves it to the front. Large files yield after each eight-chunk embedding batch so newly opened files can progress between batches. Closing a document tab does not stop its background job. Full application quit stops processing until the next launch.

Settings → General → Document Memory shows indexing/model status and database location. Users can pause background indexing, exclude individual remembered files, or clear the index. Exclusions persist. Clearing never causes an automatic reimport of Recent on restart.

Saved changes trigger refresh. Files changed outside GenOffice are found by the folder watcher and the reconcile pass described under "Keeping the index current" below; the old once-a-minute `stat()` of every known file no longer exists. Missing files cannot supply verified answers. A changed source invalidates the old chunk and asks the AI to search again. Rename/move operations inside GenOffice update the remembered path.

## Keeping the index current

- **Query-time freshness.** After a search ranks its hits, the manager `stat()`s only those files (at most the result limit; no hashing) and compares mtime and size with the indexed values. Each hit carries `stale`, `missing`, `indexedAt` (epoch ms of the last index write) and `truncated`. `stale: true` means the file changed or vanished since indexing, so the snippet must not be quoted: the assistant is told to call the read tool or search again. `missing: true` (always with `stale`) means nothing exists at the indexed path. A stale-but-present file is queued for a prioritized re-index immediately. A stat that times out or fails for another reason (permissions, network) is treated as unknown, not stale.
- **Folder watcher.** For every scanned folder whose job is running or complete, `folder-watch.ts` opens a native recursive `fs.watch`. Events are coalesced (4 s quiet period, 30 s maximum) and filtered with the scanner's rules: supported extensions only, no hidden/generated folders, and no lock or temporary files (`~$*`, `.tmp`, `.crdownload`, `.partial`, `.part`, `.lock`, `.swp`, `.bak`). Added or changed files are enrolled; vanished files are tombstoned. Folder-level events (a folder moved or deleted) request a throttled reconcile instead. The watcher closes while memory is paused or disabled, reopens on resume, and is closed on quit. If a root is unavailable (an unplugged drive) or the watcher errors, it retries with exponential backoff (30 s up to 10 min) and re-checks the root when it returns; it never throws into the app.
- **Reconcile pass.** About 45 s after launch (and when memory is resumed) and then every 6 hours, each completed root is re-walked using file metadata only. No file contents are read or hashed, except to confirm a move candidate. The pass enrolls new files, queues changed ones and tombstones vanished ones. It does not touch the scan job's discovery counters, so the UI never appears to restart from zero; it records `reconciledAt` on the job instead. It skips an unreachable root entirely.
- **Safety poll.** The one-minute timer now only resumes interrupted work from SQL. Every 5 minutes it also `stat()`s the 200 most recently opened documents, which may live outside any scanned folder.

### Tombstones and moves

When a file is gone, its chunks, FTS rows and vectors are deleted and its document row is removed, instead of leaving an `unavailable` error row with stale text. A removal is held for a 30 s grace period first and is only applied if the file still does not exist **and** its drive or share root is reachable, so unplugging a disk never wipes its index. A user exclusion is never removed: an excluded file stays excluded even if deleted. If a new file appears whose size and SHA-256 match a document that just went missing (up to 64 MB), it is treated as a move: the existing row, chunks and vectors are carried to the new path with no re-extraction or re-embedding.

### Cost control

- At most 400 chunks are stored per file. CSV/TSV files index the header plus evenly sampled rows (at most 120 chunks, each repeating the header, located as `Sampled rows a-b`). Purely numeric tables are stored for full-text search only and are not embedded.
- Whenever content was left out, the document's `truncated` flag is set (SQLite column `documents.truncated`, added automatically to existing databases without touching existing rows). It is exposed on search hits, per-document progress and as `truncatedFiles` in the folder progress aggregate.
- The indexing worker runs extraction and embedding on one queue so the 35% CPU budget applies to both; query embeddings and verification reads jump the queue and cut a cool-down sleep short. Embedding stays one text at a time.
- Existing indexes keep their old chunks until a file is re-indexed; the caps apply to new extractions.

## Limits

Text extraction covers the document formats supported by the existing file parser: Word, spreadsheets, presentations, text PDFs, Markdown and HTML. Image-only scans need OCR; empty extraction is shown explicitly. Files above 128 MB produce an indexing error, with no silent content truncation. Unsaved changes must be saved before document memory can read them.

If model download or inference fails, indexed text remains searchable. The next indexing retry can load the model again. Vectors are stored in SQLite and scanned in a worker using a cursor and a bounded heap of 200 candidates. For stores above 15,000 compatible vectors, semantic search first scans at most 12,000 vectors from the 1,024 most recently opened or modified documents. If that sample has no strong semantic score and margin, and the query has no strong same-chunk lexical match, the search widens to at most 48,000 vectors from 4,096 recent documents; weak or ambiguous results then trigger a full semantic scan. These thresholds are source constants and intentionally conservative. E5 cosine scores can be high for unrelated text, so a strong recent result is only a budget heuristic; it cannot prove that no unique old semantic match exists without scanning old vectors.

SQLite FTS5 still searches the full enrolled corpus at every age. Lexical results receive twice the reciprocal-rank weight of semantic results, which protects distinctive old matches such as names, codes and phrases. A small recency bonus only settles close result ties. Old documents and vectors are retained and searchable; age never removes them. Searches that depend on semantic similarity alone may miss a unique old match when a recent sample is sufficiently strong. This version still has no HNSW/ANN index, so ambiguous cold searches can scan all compatible vectors and latency can grow with corpus size. Each machine has its own database; shared PVE storage is a separate future deployment.

## Capacity errors while answering

Gemini HTTP 503 and statusless high-demand messages are classified as temporary overload. Bounded retries and automatic model routing can continue an interrupted text answer using the already visible text and existing evidence. Continuation requests disable tools. Once a tool call has been emitted, the transport does not replay that attempt. A manually selected model remains selected, and cancellation, attempt limits and the total routing deadline still apply. Exhausted recovery shows the localized busy message.

## Model attribution

Model: https://huggingface.co/intfloat/multilingual-e5-small (MIT license).
ONNX conversion: https://huggingface.co/Xenova/multilingual-e5-small.
Runtime: ONNX Runtime (MIT); Hugging Face Tokenizers.js (Apache-2.0).

## Selected-folder scanning

In Settings → General → Document memory, choose **Scan folder** to discover supported
files recursively. On Windows, the installer adds **Scan folder with GenOffice AI** to
Explorer's folder context menu (Windows 11 may place it under **Show more options**).
On macOS, the packaged app installs the owned **Scan with GenOffice AI** Finder service
and Quick Action. It receives one selected folder, also available through Finder → Services.

Discovery counts are separate from the existing indexing/embedding queue. Newly discovered
files use their modification time for priority and do not count as recently opened files.
Unchanged files retain their existing index; exclusions remain respected. Hidden/generated
directories, symbolic links, unsupported files and files over 128 MiB are skipped. A scan
cannot select a drive root. The scanner stores its job in `document-memory-folders.json`
inside the app's user-data directory. Interrupted traversal restarts within the selected
folder on launch; unchanged documents do not get embedded again. A completed scan is never repeated in full: new, changed, moved and deleted files are picked up by the watcher and the reconcile pass above. Explicit Stop, disabling
memory, or clearing the index persists a stop so discovery does not resume automatically.
