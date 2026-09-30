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

Saved changes trigger refresh; periodic checks also refresh known files changed outside GenOffice. Missing files cannot supply verified answers. A changed source invalidates the old chunk and asks the AI to search again. Rename/move operations inside GenOffice update the remembered path.

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
