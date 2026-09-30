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

Each embedding batch is committed independently. If the application closes or loses power, the next launch automatically resumes pending files and starts from the first missing vector for unchanged files. Completed chunk IDs and vectors are retained; only an unfinished batch needs recomputation. Closing a document tab does not stop its background job. Full application quit stops processing until the next launch.

Settings → General → Document Memory shows indexing/model status and database location. Users can pause background indexing, exclude individual remembered files, or clear the index. Exclusions persist. Clearing never causes an automatic reimport of Recent on restart.

Saved changes trigger refresh; periodic checks also refresh known files changed outside GenOffice. Missing files cannot supply verified answers. A changed source invalidates the old chunk and asks the AI to search again. Rename/move operations inside GenOffice update the remembered path.

## Limits

Text extraction covers the document formats supported by the existing file parser: Word, spreadsheets, presentations, text PDFs, Markdown and HTML. Image-only scans need OCR; empty extraction is shown explicitly. Files above 128 MB produce an indexing error, with no silent content truncation. Unsaved changes must be saved before document memory can read them.

If model download or inference fails, indexed text remains searchable. The next indexing retry can load the model again. Vectors are stored in SQLite and scanned in a worker using a cursor and a bounded heap of 200 candidates; vector retrieval does not load all vectors or sort the entire corpus in RAM. Search still examines every compatible vector, so latency grows with chunk count; this first version does not yet use an approximate nearest-neighbor index for millions of chunks. Each machine has its own database; shared PVE storage is a separate future deployment.

## Capacity errors while answering

Gemini HTTP 503 and statusless high-demand messages are classified as temporary overload. Bounded retries and automatic model routing can continue an interrupted text answer using the already visible text and existing evidence. Continuation requests disable tools. Once a tool call has been emitted, the transport does not replay that attempt. A manually selected model remains selected, and cancellation, attempt limits and the total routing deadline still apply. Exhausted recovery shows the localized busy message.

## Model attribution

Model: https://huggingface.co/intfloat/multilingual-e5-small (MIT license).
ONNX conversion: https://huggingface.co/Xenova/multilingual-e5-small.
Runtime: ONNX Runtime (MIT); Hugging Face Tokenizers.js (Apache-2.0).
