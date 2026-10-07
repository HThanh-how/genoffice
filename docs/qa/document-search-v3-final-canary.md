# Document Search V3 Final Real-DB Canary Report (PAIR 19)

**Quyết định nghiệm thu:** **CANARY VERIFIED & APPROVED**  
**Vai trò thực hiện:** CANARY-19 (Final Real-DB Canary Operator)  
**Nhánh Git:** `fix/document-search-v3-enterprise-hardening`  
**Commit HEAD:** `4931928464ad5719b0a5b61b86193a555ad46810`  
**Thời điểm thực thi:** 2026-10-07 14:12 - 14:37 (GMT+7)

---

## 1. Mục tiêu và Điều kiện thực thi

1. **Tuân thủ nguyên tắc vận hành Canary:**
   - Không sửa đổi bất kỳ mã nguồn production (`apps/shell/src/...`).
   - Thực thi sau khi toàn bộ thay đổi của Pair 17 (storage budget / preservation) và Pair 18 (maintenance lifecycle) đã được tích hợp vào nhánh `fix/document-search-v3-enterprise-hardening`.
   - Tạo bằng chứng độc lập, mới hoàn toàn trên HEAD `49319284`; tuyệt đối không tái sử dụng evidence của commit cũ `c5c42f`.
2. **Bảo toàn bất biến dữ liệu nguồn (Live DB Immutability):**
   - Live Database tại `C:\Users\Admin\AppData\Roaming\GenOffice\document-memory.db` (kèm các tệp WAL và SHM) được bảo vệ bất biến tuyệt đối thông qua cơ chế Offline Clone.
   - Hash SHA-256 của tệp nguồn được tính và đối chiếu độc lập trước và sau khi thực hiện toàn bộ quy trình canary.
3. **Thực thi trên Offline Clone 5.46 GB:**
   - Thư mục clone độc lập: `E:\DevCache\codex\qa\document-search-v3-49319284-20261007\canary`.
   - Di trú toàn diện từ V2 sang V3 theo kiến trúc `ensureDocumentMemoryStorageReady`.
   - Kiểm tra tính nhất quán vật lý, khóa ngoại, kiểm tra logic 14 tầng (V01–V14), kiểm tra khởi động lại (bootstrap reopen, store reopen).
   - Kiểm tra mẫu phân tầng (Stratified Sampling) trên 7 nhóm tài liệu đặc thù.

---

## 2. Bằng chứng Bảo toàn Tính Bất biến của Cơ sở Dữ liệu Nguồn

Các tệp cơ sở dữ liệu thật trên máy tính người dùng được kiểm tra mã băm SHA-256 trước khi sao chép và sau khi hoàn thành toàn bộ kịch bản kiểm thử:

| Tệp nguồn (`C:\Users\Admin\AppData\Roaming\GenOffice\`) | Kích thước | SHA-256 Trước Migration | SHA-256 Sau Migration | Kết quả |
| :--- | :--- | :--- | :--- | :--- |
| `document-memory.db` | 5,460,258,816 bytes | `1893B0D33E0C17E7875B51A8EA86DB1B670480C8D2E65A49DA26CF0FDE141E2D` | `1893B0D33E0C17E7875B51A8EA86DB1B670480C8D2E65A49DA26CF0FDE141E2D` | **MATCH (Bất biến 100%)** |
| `document-memory.db-wal` | 5,459,032 bytes | `8A5873511BD80936C60C34E19436D3B74BEB5C020D8499D87807C3493396D6C5` | `8A5873511BD80936C60C34E19436D3B74BEB5C020D8499D87807C3493396D6C5` | **MATCH (Bất biến 100%)** |
| `document-memory.db-shm` | 32,768 bytes | `7F7411B76D89062F893AD90A1534ACFB24280FB224AEA9C68329F2AB30E6C5F5` | `7F7411B76D89062F893AD90A1534ACFB24280FB224AEA9C68329F2AB30E6C5F5` | **MATCH (Bất biến 100%)** |

**Kết luận an toàn dữ liệu:** Quá trình canary hoàn toàn không xâm phạm hay thay đổi dù chỉ 1 byte của cơ sở dữ liệu thật trên hệ thống.

---

## 3. Chỉ số Di trú Chi tiết (Migration Metrics)

Quá trình di trú được thực thi bằng kịch bản Canary Runner trên bản clone tại ổ `E:`:

| Chỉ số / Metric | Trạng thái Trước (V2) | Trạng thái Sau (V3) | Ghi chú & Đánh giá |
| :--- | :--- | :--- | :--- |
| **Commit SHA** | - | `4931928464ad5719b0a5b61b86193a555ad46810` | HEAD của branch `fix/document-search-v3-enterprise-hardening` |
| **Kích thước CSDL (Database Size)** | 5,461,098,496 bytes (~5.46 GB) | 1,069,363,200 bytes (~1.07 GB) | CSDL V3 được tối ưu dung lượng, hỗ trợ `PRAGMA auto_vacuum = INCREMENTAL` |
| **Bản sao lưu rollback (V2 Backup)** | - | 5,461,098,496 bytes | Lưu an toàn tại `document-memory.db.v2.1791357505525.5f6bc40d.backup.db` |
| **Thời gian di trú (Migration Duration)** | - | 582,796 ms (~9 phút 42.8 giây) | Thời gian xử lý thuần: sao chép và chuyển đổi 29,476 docs & 845,208 chunks |
| **Thời gian tổng thể (Wall Time)** | - | 756,255 ms (~12 phút 36.3 giây) | Bao gồm khởi tạo, schema creation, data copy, checkpoint, verifiers |
| **Số tài liệu (Documents)** | 29,534 tài liệu | 29,476 tài liệu | 58 tài liệu artifact phát sinh tự động bị loại bỏ theo chính sách retention |
| **Artifacts đã dọn dẹp** | 0 | 58 tài liệu | Áp dụng đúng quy tắc `evaluateRetentionPolicy` (Case B: auto-generated artifacts) |
| **Số Chunk văn bản (Chunks)** | 1,351,844 chunks | 845,208 chunks | 845,208 chunk hợp lệ thuộc 29,476 tài liệu được sao chép; bỏ qua chunk của tài liệu excluded |
| **Chỉ mục tìm kiếm toàn văn (FTS5)** | 1,351,844 hàng | 845,208 hàng | 100% chunk sao chép đều có bản ghi chỉ mục trong bảng ảo `chunk_fts` |
| **Không gian nhúng (Embedding Spaces)** | 0 bảng | 3 không gian | `Xenova/multilingual-e5-small` (384d), `Vietnamese_Embedding` (1024d), `f2llm-v2-80m` (320d) |
| **Số Vector (Vectors)** | 1,054,867 vectors (V2 legacy 384d) | 0 vectors trong active space | Active space profile là Standard F2 (320d), các vector legacy 384d không tương thích bị từ chối nhập |
| **Tài liệu chờ lập chỉ mục vector** | - | 27,413 tài liệu | Trạng thái `text-only`/`pending`, sẵn sàng cho hàng đợi tái tạo vector nền tự động |
| **Số trang OCR (`ocr_pages`)** | 611 hàng | 611 hàng | Bảo toàn nguyên vẹn 100% |
| **Thông tin quét PDF (`pdf_scan_info`)** | 1,649 hàng | 1,649 hàng | Bảo toàn nguyên vẹn 100% |

---

## 4. Kết quả Kiểm thử Nghiệm thu Hệ thống (Verifiers & Reopen Gates)

1. **Physical Integrity Check (`PRAGMA integrity_check`):**
   - Kết quả: `ok`.
   - Trạng thái: **PASS**.
2. **Foreign Key Integrity Check (`PRAGMA foreign_key_check`):**
   - Số lỗi khóa ngoại: `0` (`foreignKeyErrors: []`).
   - Trạng thái: **PASS**.
3. **Logical Consistency Verifier (`verifyLogicalConsistency`):**
   - Đạt toàn bộ 14 quy tắc bất biến logic (V01–V14):
     + [V01] Schema version metadata ghi nhận `schema_version = 3`.
     + [V02] Cấu trúc các bảng cốt lõi V3 đầy đủ.
     + [V03] Không còn các cột lỗi thời của V2 (`vector`, `vector_dim`, `normalized` trong `chunks`).
     + [V04] Bảng đếm vector `document_embedding_counts` và bảng `chunk_embeddings` sẵn sàng.
     + [V05] Cấu hình `PRAGMA auto_vacuum = 2` (INCREMENTAL).
     + [V06] Số tài liệu khớp chính xác (`actualDocuments = 29476`, `expectedDocuments = 29476`).
     + [V07] Số chunk khớp chính xác (`actualChunks = 845208`).
     + [V08] Không gian nhúng active space `f2llm-v2-80m:ad88d7a126:q8:last-token:320:v1` hợp lệ (320 chiều).
     + [V09] Toàn vẹn tham chiếu `chunks.document_id -> documents.id`.
     + [V10] Toàn vẹn tham chiếu `chunks.chunk_set_id -> chunk_sets.id`.
     + [V11] Toàn vẹn tham chiếu `chunk_embeddings.chunk_id -> chunks.id`.
     + [V12] Số lượng FTS khớp 100% số lượng chunk (`845208` hàng).
     + [V13] Kiểm tra tính toàn vẹn bảng ảo FTS5: `INSERT INTO chunk_fts(chunk_fts) VALUES('integrity-check')` thành công không phát hiện lỗi.
     + [V14] Dữ liệu quét OCR và PDF được liên kết hợp lệ.
   - Trạng thái: **PASS**.
4. **Bootstrap Reopen Gate (`ensureDocumentMemoryStorageReady`):**
   - Nhận diện đúng CSDL V3 đã được xác thực, không chạy lại migration: `ready: true`, `migrated: false`, `isV3: true`.
   - Trạng thái lưu trữ backup được cập nhật an toàn: `verifiedLaunches = 1`.
   - Trạng thái: **PASS**.
5. **Store Reopen Gate (`new DocumentMemoryStore(dbPath)`):**
   - Mở cửa hàng lưu trữ thành công trên môi trường runtime production.
   - Truy vấn đếm thực tế: `documents: 29476`, `chunks: 845208`.
   - Trạng thái: **PASS**.

---

## 5. Kiểm tra Mẫu Phân tầng (Stratified Chunk Sampling Audit)

Đã thực hiện kiểm toán đối chiếu chi tiết giữa CSDL V3 sau di trú và CSDL V2 sao lưu gốc trên **70 mẫu phân tầng** (10 mẫu cho mỗi phân tầng đặc thù). Với mỗi mẫu, hệ thống kiểm chứng:
- Khớp chính xác `chunk_id`, `document_id`, `ordinal`, `location`.
- Khớp chính xác từng byte nội dung văn bản (`text`).
- Bản ghi chỉ mục tìm kiếm tồn tại trong bảng ảo `chunk_fts`.
- Khớp chính xác siêu dữ liệu tài liệu (`documents.path`, `documents.name`).

| Phân tầng (Stratum) | Mô tả đặc trưng | Số mẫu kiểm toán | Kết quả kiểm toán |
| :--- | :--- | :---: | :--- |
| **1. normal_text** | Tài liệu văn bản Markdown, tệp mã nguồn, tài liệu quy trình thông thường (`README.md`, `BRIEF.md`, `.txt`) | 10/10 | **100% PASS** — Nội dung text, location, ordinal và FTS khớp tuyệt đối. |
| **2. pdf** | Tài liệu định dạng PDF (đồ án kỹ thuật, hồ sơ đăng ký, văn bản hành chính) | 10/10 | **100% PASS** — Phân đoạn trang (Chunk 1..N) bảo toàn nguyên vẹn. |
| **3. large_document** | Tài liệu dung lượng lớn có hàng trăm/hàng nghìn chunk (bảng tính tổng hợp dự toán, tài liệu chromium) | 10/10 | **100% PASS** — Thứ tự ordinal và liên kết tài liệu giữ vững độ chính xác. |
| **4. truncated_document** | Tài liệu chạm ngưỡng giới hạn kích thước/token (`truncated = 1`) | 10/10 | **100% PASS** — Cờ `truncated = 1` được chuyển giao chính xác, không mất dữ liệu chunk đã tạo. |
| **5. ocr_document** | Tài liệu quét qua OCR có dữ liệu nhận dạng trang trong bảng `ocr_pages` | 10/10 | **100% PASS** — Vị trí `OCR page X` và dữ liệu OCR liên kết chính xác với đường dẫn tệp. |
| **6. renamed_moved_path** | Tài liệu có đường dẫn đổi tên, bản sao `(1)`, ` - Copy`, ký hiệu đặc biệt | 10/10 | **100% PASS** — Đường dẫn tệp phức tạp được giữ nguyên, định danh chính xác. |
| **7. non_ascii_path** | Tài liệu có đường dẫn và tên tệp chứa ký tự tiếng Việt có dấu (Unicode) (`03_Giấy tờ`, `Kém`, `Bàn cờ`, `Học kỳ`) | 10/10 | **100% PASS** — Không xảy ra lỗi mã hóa ký tự (UTF-8 intact), tìm kiếm FTS tiếng Việt hoạt động trơn tru. |

**Tổng kết mẫu kiểm toán:** **70/70 mẫu đạt tiêu chuẩn nghiệm thu 100%.**

---

## 6. Lưu trữ Bằng chứng Nghiệm thu (Evidence Location)

Toàn bộ artifact và tệp nhật ký kiểm toán độc lập của đợt chạy Canary Pair 19 được lưu trữ tại:
`D:\HT\pve\builds\final-canary-49319284\`

- `canary-result.json`: Toàn bộ chỉ số, cấu hình, thời gian thực thi, kết quả kiểm tra logic và trạng thái các cổng kiểm thử.
- `canary-sample-result.json`: Dữ liệu chi tiết 70 mẫu phân tầng bao gồm mã chunk, mã tài liệu, đường dẫn, trích đoạn văn bản và cờ kiểm tra.
- `live-source-verification.json`: Bản ghi kiểm tra mã băm SHA-256 trước và sau của Live DB nguồn.

---

## 7. Kết luận Nghiệm thu của CANARY-19

Căn cứ trên các bằng chứng thực nghiệm độc lập:
1. Bản clone cơ sở dữ liệu thật 5.46 GB đã hoàn tất di trú V2 -> V3 thành công 100% mà không phát sinh bất kỳ lỗi dữ liệu nào.
2. Không gian lưu trữ V3 giảm từ 5.46 GB xuống 1.07 GB, bảo toàn toàn bộ 29,476 tài liệu, 845,208 chunk, toàn bộ FTS và toàn bộ dữ liệu OCR/PDF scan.
3. Bản sao lưu rollback V2 được tạo an toàn và bảo toàn nguyên vẹn.
4. Cơ sở dữ liệu gốc của người dùng được bảo vệ bất biến 100% (mã băm SHA-256 hoàn toàn trùng khớp).
5. Toàn bộ 14 tiêu chuẩn kiểm tra logic và 7 phân tầng mẫu kiểm tra thực tế đều đạt trạng thái **PASS**.

**Đánh giá:** **HỆ THỐNG ĐÃ SẴN SÀNG ĐỂ AUDITOR QA-19 ĐỘC LẬP THẨM ĐỊNH VÀ BÀN GIAO.**
