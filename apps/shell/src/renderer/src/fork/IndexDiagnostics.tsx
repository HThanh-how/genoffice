import { useCallback, useEffect, useState } from 'react'
import type {
  DocumentIndexSnapshot,
  EmbeddingModelState,
} from '../../../shared/fork/document-index-api'
import type { DocumentMemoryStatus, HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { readIndexRequest } from './index-request'

export interface IndexDiagnosticsProps {
  api: HomeApi
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIdx = 0
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024
    unitIdx++
  }
  return `${size.toFixed(1)} ${units[unitIdx]}`
}

export function IndexDiagnostics({ api }: IndexDiagnosticsProps) {
  const { lang, dateLocale } = useI18n()
  const isVi = lang === 'vi'

  const [memory, setMemory] = useState<DocumentMemoryStatus | null>(null)
  const [modelState, setModelState] = useState<EmbeddingModelState | null>(null)
  const [snapshot, setSnapshot] = useState<DocumentIndexSnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [memRes, modelRes, snapRes] = await Promise.allSettled([
        readIndexRequest(
          () => api.getDocumentMemoryStatus(),
          (v): v is DocumentMemoryStatus =>
            !!v && typeof v === 'object' && typeof (v as DocumentMemoryStatus).enabled === 'boolean',
        ),
        api.getEmbeddingModel ? api.getEmbeddingModel() : Promise.resolve(null),
        api.getDocumentIndexSnapshot ? api.getDocumentIndexSnapshot(true) : Promise.resolve(null),
      ])

      if (memRes.status === 'fulfilled') setMemory(memRes.value)
      if (modelRes.status === 'fulfilled') setModelState(modelRes.value)
      if (snapRes.status === 'fulfilled' && snapRes.value) setSnapshot(snapRes.value)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const profile = modelState?.profile ?? 'standard'
  const activeProfileData = modelState?.profiles?.[profile]
  const dimensions = activeProfileData?.dimensions ?? (profile === 'high' ? 512 : 320)

  // Model names derived from actual dimensions metadata (Spec 35)
  const modelArchitecture =
    profile === 'high'
      ? `Qwen3-Embedding-0.6B (${dimensions}D)`
      : `F2LLM-v2-80M (${dimensions}D)`

  const storage = snapshot?.storage
  const performance = snapshot?.performance
  const topOffenders = storage?.topOffendersByChunks?.slice(0, 10) ?? []

  return (
    <div className="idx-diagnostics-card" aria-label={isVi ? 'Thông số chẩn đoán' : 'Diagnostics'}>
      <div className="idx-diagnostics-header">
        <div>
          <h4>{isVi ? 'Chẩn đoán kỹ thuật chỉ mục V3' : 'Index Technical Diagnostics V3'}</h4>
          <p className="idx-muted">
            {isVi
              ? 'Chi tiết kiến trúc mô hình, vector ANN, phân bổ lưu trữ đĩa và độ trễ hệ thống.'
              : 'Details on model architecture, ANN vectors, storage breakdown, and event-loop latency.'}
          </p>
        </div>
        <button
          type="button"
          className="idx-btn idx-btn-sm"
          disabled={loading}
          onClick={() => void loadData()}
        >
          {loading ? (isVi ? 'Đang cập nhật…' : 'Updating…') : isVi ? 'Cập nhật' : 'Refresh'}
        </button>
      </div>

      <div className="idx-diagnostics-grid">
        {/* Model Architecture */}
        <div className="idx-diagnostics-section">
          <h5>{isVi ? 'Mô hình nhúng ngữ nghĩa (Embedding)' : 'Embedding Model Architecture'}</h5>
          <dl className="idx-diagnostics-dl">
            <div>
              <dt>{isVi ? 'Cấu hình đang dùng' : 'Active Profile'}</dt>
              <dd>
                <strong>{profile === 'high' ? 'High Quality' : 'Standard'}</strong>
              </dd>
            </div>
            <div>
              <dt>{isVi ? 'Mô hình gốc' : 'Model Engine'}</dt>
              <dd>{modelArchitecture}</dd>
            </div>
            <div>
              <dt>{isVi ? 'Số chiều Vector (Dimensions)' : 'Vector Dimensions'}</dt>
              <dd>{dimensions}D</dd>
            </div>
            <div>
              <dt>{isVi ? 'Dung lượng tải / RAM' : 'Download / RAM Footprint'}</dt>
              <dd>
                ~{activeProfileData?.downloadMB ?? (profile === 'high' ? 600 : 80)} MB tải · ~
                {activeProfileData?.memoryMB ?? (profile === 'high' ? 1200 : 150)} MB RAM
              </dd>
            </div>
            <div>
              <dt>{isVi ? 'Trạng thái mô hình' : 'Model State'}</dt>
              <dd>
                <span className={`idx-diag-tag ${memory?.modelState === 'ready' ? 'is-ok' : ''}`}>
                  {memory?.modelState ?? 'not-loaded'}
                </span>
              </dd>
            </div>
          </dl>
        </div>

        {/* Vector Store & ANN */}
        <div className="idx-diagnostics-section">
          <h5>{isVi ? 'Chỉ mục Vector & ANN Search' : 'Vector Index & ANN Engine'}</h5>
          <dl className="idx-diagnostics-dl">
            <div>
              <dt>{isVi ? 'Cấu trúc tìm kiếm ANN' : 'ANN Index Type'}</dt>
              <dd>USearch / Exact Vector Index (HNSW Cosine)</dd>
            </div>
            <div>
              <dt>{isVi ? 'Chuẩn hóa vector' : 'Vector Normalization'}</dt>
              <dd>L2 Unit-Norm (Cosine Similarity)</dd>
            </div>
            <div>
              <dt>{isVi ? 'Tổng số Vector' : 'Total Vectors'}</dt>
              <dd>{(memory?.vectors ?? 0).toLocaleString(dateLocale)}</dd>
            </div>
            <div>
              <dt>{isVi ? 'Tổng số đoạn (Chunks)' : 'Total Passages/Chunks'}</dt>
              <dd>{(memory?.chunks ?? 0).toLocaleString(dateLocale)}</dd>
            </div>
            <div>
              <dt>{isVi ? 'Số tệp đã index' : 'Total Documents'}</dt>
              <dd>{(memory?.documents ?? 0).toLocaleString(dateLocale)}</dd>
            </div>
          </dl>
        </div>

        {/* Enterprise Storage Diagnostics (Spec 36, 37) */}
        <div className="idx-diagnostics-section">
          <h5>{isVi ? 'Phân bổ lưu trữ cơ sở dữ liệu V3' : 'V3 Database Storage Footprint'}</h5>
          <dl className="idx-diagnostics-dl">
            <div>
              <dt>{isVi ? 'Kích thước DB chính' : 'Active DB Size'}</dt>
              <dd><strong>{formatBytes(storage?.activeDbSizeBytes)}</strong></dd>
            </div>
            <div>
              <dt>{isVi ? 'Kích thước WAL tạm' : 'WAL File Size'}</dt>
              <dd>{formatBytes(storage?.walSizeBytes)}</dd>
            </div>
            <div>
              <dt>{isVi ? 'Dung lượng có thể thu hồi' : 'Reclaimable Freelist'}</dt>
              <dd>{formatBytes(storage?.estimatedReclaimableBytes)} ({storage?.freelistCount?.toLocaleString(dateLocale) ?? 0} trang)</dd>
            </div>
            {storage?.v2BackupSizeBytes != null && (
              <div>
                <dt>{isVi ? 'Bản sao lưu V2' : 'V2 Backup Size'}</dt>
                <dd>{formatBytes(storage.v2BackupSizeBytes)}</dd>
              </div>
            )}
            {storage?.breakdown && (
              <div>
                <dt>{isVi ? 'Chi tiết: Chunks / Vectors / FTS' : 'Breakdown: Chunks / Vectors / FTS'}</dt>
                <dd>
                  {formatBytes(storage.breakdown.chunksBytes)} / {formatBytes(storage.breakdown.embeddingsBytes)} / {formatBytes(storage.breakdown.ftsBytes)}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/* Runtime Performance & Latency */}
        <div className="idx-diagnostics-section">
          <h5>{isVi ? 'Độ trễ tiến trình & SQLite' : 'Event Loop & SQLite Latency'}</h5>
          <dl className="idx-diagnostics-dl">
            <div>
              <dt>{isVi ? 'Độ trễ Event Loop (p50 / p95)' : 'Event Loop (p50 / p95)'}</dt>
              <dd>
                {performance?.eventLoop ? `${performance.eventLoop.p50} ms / ${performance.eventLoop.p95} ms (max: ${performance.eventLoop.max} ms)` : '–'}
              </dd>
            </div>
            <div>
              <dt>{isVi ? 'Thao tác SQLite chậm (>16ms)' : 'Slow DB Operations (>16ms)'}</dt>
              <dd>{performance?.sqliteLatency?.slowOperationCount ?? 0}</dd>
            </div>
            <div>
              <dt>{isVi ? 'Dung lượng RAM hệ thống' : 'System RAM'}</dt>
              <dd>{modelState?.machine.totalMemGiB ?? '–'} GB RAM</dd>
            </div>
            <div>
              <dt>{isVi ? 'Luồng xử lý CPU' : 'CPU Logical Cores'}</dt>
              <dd>{modelState?.machine.logicalCores ?? '–'} Threads</dd>
            </div>
            <div>
              <dt>{isVi ? 'Vị trí CSDL chỉ mục' : 'Index Database Path'}</dt>
              <dd className="idx-diag-path" title={memory?.dbPath ?? ''}>
                {memory?.dbPath || 'Default user data store'}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Large File Visibility / Top Offenders (Spec 38) */}
      {topOffenders.length > 0 && (
        <div className="idx-diagnostics-section" style={{ marginTop: '16px' }}>
          <h5>{isVi ? 'Top tài liệu chiếm nhiều đoạn chunk nhất (Cảnh báo file bất thường)' : 'Top Documents by Chunk Count (Offender Visibility)'}</h5>
          <div style={{ maxHeight: '180px', overflowY: 'auto', fontSize: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                  <th style={{ padding: '4px 8px' }}>{isVi ? 'Tên tệp' : 'File Name'}</th>
                  <th style={{ padding: '4px 8px', width: '90px' }}>{isVi ? 'Số chunks' : 'Chunks'}</th>
                  <th style={{ padding: '4px 8px', width: '90px' }}>{isVi ? 'Bị cắt bớt' : 'Truncated'}</th>
                </tr>
              </thead>
              <tbody>
                {topOffenders.map((item) => (
                  <tr key={item.id} style={{ borderBottom: '1px solid var(--border-color, #f0f0f0)' }}>
                    <td style={{ padding: '4px 8px', wordBreak: 'break-all' }} title={item.path}>
                      {item.name}
                    </td>
                    <td style={{ padding: '4px 8px' }}><strong>{item.chunks.toLocaleString(dateLocale)}</strong></td>
                    <td style={{ padding: '4px 8px' }}>{item.truncated ? (isVi ? 'Có' : 'Yes') : (isVi ? 'Không' : 'No')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
