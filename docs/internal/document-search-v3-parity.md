# GENOFFICE DOCUMENT SEARCH V3 — RUNTIME BEHAVIOR PARITY LEDGER
**Tham chiếu chuẩn hành vi:** Parent commit `b847fce666c5ad33dd73c15f3f59191da284c1ff`  
**Nhánh tích hợp:** `fix/document-search-v3-enterprise-hardening`  
**Mục tiêu:** Khắc phục triệt để các hành vi runtime bị mất hoặc bị biến thành stub sau đợt modularize `760aab6c`, đồng thời bảo đảm các giới hạn LOC kiến trúc (manager <= 500, store <= 400, storage-migration <= 200, document-index-ipc <= 250, IndexDashboard <= 250) bằng kỹ thuật ủy quyền (delegation) chuẩn Enterprise.

---

## 1. BẢNG ĐỐI CHIẾU HÀNH VI RUNTIME (PARITY LEDGER MATRIX)

| ID | Hành Vi / Thành Phần Trong `b847fce6` | Trạng Thái Bị Thoái Hóa Ở `760aab6c` | Module Đích Ủy Quyền Trong V3 | Hợp Đồng Chức Năng (Contract & Parity Guarantee) | Test Suite Kiểm Chứng |
|---|---|---|---|---|---|
| **BEH-01** | Process-isolated Worker (`createIndexProcess`, `electron-as-node`, below-normal priority) | Thay bằng `new Worker(thread)` thông thường làm mất cách ly CPU | `runtime/worker-pool.ts` hoặc `manager.ts` dùng `createIndexProcess` | Khởi tạo worker qua child process, tách biệt heap, tuân thủ `attachChildToPolicy` | `document-memory-process.test.ts` |
| **BEH-02** | Live Watcher Hooks (`onEnabledChange`, `onCleared`) | Bị lược bỏ, `FolderScanManager` không nhận được sự kiện | `manager.ts` | Khôi phục mảng callbacks `onEnabledChange` và `onCleared`, kích hoạt đúng lúc | `document-memory-folder-watch.test.ts` |
| **BEH-03** | Thư mục Scanned Reconciliation (`reconcileFolder`, `reconcileSubtree`) | Biến thành stub `{ added: 0, changed: 0, moved: 0, removed: 0 }` | `runtime/freshness-coordinator.ts` | Quét theo trang `documentsUnderPage`, đối chiếu `seen`, phát hiện move bằng hash/size, gọi `tombstone` cho file mất | `document-memory-folder-scan.test.ts` |
| **BEH-04** | Đọc tức thì file chỉ định (`readNowDocument`) | Biến thành stub `{ ok: true }` ngay khi enqueue, không chờ kết quả | `manager.ts` + `runtime/extraction-coordinator.ts` | Tạo Deferred Promise, gửi request `interactive: true` sang worker, đợi kết quả trích xuất thật | `document-memory-read-now.test.ts` |
| **BEH-05** | Enqueue Embedding sau khi Extract (`manager.drain`) | Trích xuất xong không đẩy vào embedding queue | `runtime/embedding-coordinator.ts` | Sau khi văn bản được lưu, tự động gọi `enqueueEmbed` để chuyển các chunk sang trạng thái sinh vector | `document-memory-embeddings.test.ts` |
| **BEH-06** | Bảo vệ Race Condition (`generation`, `epoch`, `isCurrent`) | Không kiểm tra `generation` khi hoàn thành extract/embed | `manager.ts` | Kiểm tra `isCurrent(path, generation, epoch)`, huỷ kết quả trích xuất nếu file bị thay đổi trong lúc xử lý | `document-memory-stall-recovery.test.ts`, `chunk-upgrade.test.ts` (MIG-1) |
| **BEH-07** | Lưu trữ nguyên nhân cắt ngắn văn bản (`truncatedReason`) | Chỉ lưu cờ `truncated`, mất `truncatedReason` | `storage/repositories/document-repository.ts` | Lưu các giá trị enum hợp lệ: `chunk-limit`, `content-limit`, `pdf-page-limit`, `tabular-sampling` | `document-memory-pdf-limit.test.ts` |
| **BEH-08** | Ghi nhận thông tin OCR PDF Scan (`recordScanInfo`) | Bị bỏ qua không lưu thông tin trang quét | `storage/repositories/document-repository.ts` | Lưu `pdf_scan_info` (mtime_ms, size_bytes, total_pages, scanned) khi trích xuất PDF có OCR | `document-memory-mixed-pdf.test.ts` |
| **BEH-09** | Thay thế tài liệu theo lát cắt bất đồng bộ (`replaceDocumentSliced`) | Gọi thay thế đồng bộ gây nghẽn Event Loop | `storage/repositories/chunk-repository.ts` | Chia nhỏ các batch thao tác chunk và nhường quyền Event Loop bằng `createYielder()` | `document-index-responsiveness.test.ts` |
| **BEH-10** | Quản lý hàng đợi đa cấp (`urgent`, `deferred`, `FileStabilityGate`) | Logic bị thu hẹp, mất các bậc backoff 15s/60s/5m/15m | `runtime/indexing-controller.ts` / `file-stability.ts` | Điều phối thứ tự ưu tiên: Urgent > P1 (Priority Folders) > P2 (Normal) > Deferred; áp dụng backoff khi file lock | `document-memory-queue-order.test.ts`, `document-memory-stop-retry.test.ts` |
| **BEH-11** | Thực thi chính sách tạm dừng (`BackgroundWorkGate`, `isIndexingPaused`) | Manager gọi tên hàm/lớp sai, gây lỗi import/runtime | `background-work-gate.ts`, `manager.ts` | Export chuẩn xác `isIndexingPaused`, `onIndexingPolicyChange`, chặn tác vụ ngầm khi pin yếu/khóa màn hình | `indexing-pause-manager.test.ts` |
| **BEH-12** | Kiểm tra độ tươi của tài liệu (`annotateFreshness`) | Trả về stub `{ stale: false, missing: false }` | `runtime/freshness-coordinator.ts` | Kiểm tra thực tế bằng `safeStat`, đánh dấu `stale` nếu mtime/size lệch, `missing` nếu file biến mất | `document-memory.test.ts` |
| **BEH-13** | Khởi động Storage an toàn Fail-Closed | `index.ts` bỏ qua `bootstrap.ready: false`, mở DB hỏng | `apps/shell/src/main/index.ts`, `storage-bootstrap.ts` | Nếu `ready === false`, gán `documentMemory = null`, hiển thị cảnh báo lỗi và không mở kết nối database | `storage-v3-migration.test.ts` |
| **BEH-14** | Đọc cấu hình Active Embedding độc lập | Không đọc cấu hình trước khi mở DB | `storage/embedding-settings.ts` | Đọc `document-memory-embedding.json` độc lập trước khi mở DB để xác định active space | `embedding-profiles.test.ts` |
| **BEH-15** | Migration vector theo không gian hoạt động | Thiếu `AND space_id = ?`, chọn nhầm vector | `storage/migration/data-copier.ts` | Sao chép chunk embeddings khớp chính xác `activeSpaceId` và `activeDimensions` | `storage-v3-migration.test.ts` |
| **BEH-16** | Khôi phục Cutover dạng State Machine | Thiếu manifest trạng thái, mất điện giữa chừng hỏng DB | `storage/migration/cutover.ts` | Ghi file manifest `document-memory.migration-state.json` theo từng bước atomic rename | `storage-v3-cutover.test.ts` |
| **BEH-17** | Retention Policy và chống va chạm Backup | Tên backup có thể bị trùng, chưa đảm bảo retention | `storage/migration/backup-retention.ts` | Tạo tên backup duy nhất theo timestamp/nanoid, giữ tối thiểu 3 bản sao và ít nhất 24 giờ | `storage-v3-rollback.test.ts` |
| **BEH-18** | Kiểm định tính toàn vẹn Logic & Physical trước Cutover | Chỉ kiểm tra doc count/chunk count cơ bản, bỏ sót V01-V12 | `storage/migration/logical-verifier.ts` | Kiểm tra toàn diện 12 ràng buộc V01..V12 trên file tạm trước khi cho phép tiến hành rename | `storage-v3-migration.test.ts` |
| **BEH-19** | Dọn rác an toàn không xóa `building` chunk sets | Lỗi câu query xóa nhầm các chunk sets đang build | `storage/repositories/maintenance-repository.ts` | Loại trừ `state = 'building'`, đồng thời tính toán cập nhật lại `document_embedding_counts` sau GC | `storage-gc.test.ts`, `chunk-sets.test.ts` |
| **BEH-20** | Tính toán tiến độ bám sát `activeSpaceId` | Cộng dồn các space_id khác nhau làm tiến độ > 100% | `storage/repositories/progress-repository.ts` | Scope toàn bộ query tiến độ chunk, folder và semantic coverage theo đúng `activeSpaceId` | `embedding-counts.test.ts` |
| **BEH-21** | Ràng buộc khóa ngoại Cascade cho Chunks | Thiếu ON DELETE CASCADE tại một số bảng con | `storage/schema-v3.ts` | Bổ sung `chunks.chunk_set_id REFERENCES chunk_sets(id) ON DELETE CASCADE` | `chunk-sets.test.ts` |
| **BEH-22** | Chuyển tác vụ bảo trì nặng sang Worker Child Process | Chạy `mergeFtsStep`, vacuum trên Main Thread | `runtime/maintenance-scheduler.ts` + `worker.ts` | Gửi message sang worker thực hiện FTS merge, GC, và incremental vacuum giới hạn 256 trang | `fts-maintenance-worker.test.ts` |
| **BEH-23** | Snapshot trung thực không trả dữ liệu giả lập | Trả về `mode: null`, `modelState: 'ready'` hardcoded | `fork/document-index-snapshot-service.ts` | Đọc dữ liệu thực từ bộ nhớ, cache nhẹ 2s cho polling, chuyển diagnostics nặng sang cache 60s | `index-snapshot.test.ts` |
| **BEH-24** | Hợp đồng API và lưu trữ cấu hình PDF Pages | Mất cấu hình khi restart, sai định dạng trả về | `fork/document-index-folder-handlers.ts` | Trả về `{ pages, requeued }`, lưu và nạp từ file cấu hình `document-memory-pdf.json` | `document-memory-pdf-turns.test.ts` |
| **BEH-25** | Giới hạn ranh giới LOC kiến trúc sạch | Rút gọn LOC bằng cách xóa tính năng | Tách file module theo SOLID | Giữ `manager.ts` <= 500, `store.ts` <= 400 bằng cách chia nhỏ trách nhiệm sang các coordinators | `tools/check-document-memory-architecture.mjs` |

---

## 2. KẾ HOẠCH TRIỂN KHAI 6 CORRECTIVE COMMITS

1. **Commit 1:** `fix(index): restore runtime behavior parity after modularization`
   - Phục hồi BEH-01 đến BEH-12: worker process, live watcher hooks, reconcile folder thật, readNow thật, embedding enqueue, generation race guard, truncatedReason, recordScanInfo, multi-tier queue, pause policy, annotateFreshness thật.
2. **Commit 2:** `fix(index): make v3 bootstrap and active-space migration fail-safe`
   - Phục hồi BEH-13 đến BEH-18: fail-closed startup, independent embedding profile, active space migration, migration state manifest, backup retention, logical verifier V01..V12.
3. **Commit 3:** `fix(index): scope progress and storage gc to active data`
   - Phục hồi BEH-19 đến BEH-21: GC bảo vệ building chunk sets, recount embedding counts, scope progress theo activeSpaceId, FK cascades.
4. **Commit 4:** `perf(index): restore process-isolated bounded maintenance`
   - Phục hồi BEH-22: worker-isolated FTS maintenance, incremental vacuum giới hạn 256 pages, kiểm soát theo BackgroundWorkGate.
5. **Commit 5:** `fix(index): make index snapshots and diagnostics truthful`
   - Phục hồi BEH-23 và BEH-24: snapshot trung thực, cache 2s in-memory, heavy diagnostics 60s off-thread, PDF settings persistence.
6. **Commit 6:** `test(index): add enterprise parity and fault-injection coverage`
   - Bổ sung kiểm thử hồi quy toàn diện, xác nhận 100% test files PASS và kiểm tra AST architecture boundaries.
