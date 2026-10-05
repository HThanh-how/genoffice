import { useEffect, useState } from 'react'
import type {
  EmbeddingModelState,
} from '../../../shared/fork/document-index-api'
import type { DocumentMemoryStatus, HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { readIndexRequest } from './index-request'

export interface IndexDiagnosticsProps {
  api: HomeApi
}

export function IndexDiagnostics({ api }: IndexDiagnosticsProps) {
  const { lang, dateLocale } = useI18n()
  const isVi = lang === 'vi'

  const [memory, setMemory] = useState<DocumentMemoryStatus | null>(null)
  const [modelState, setModelState] = useState<EmbeddingModelState | null>(null)
  const [loading, setLoading] = useState(false)

  const loadData = async () => {
    setLoading(true)
    try {
      const [memRes, modelRes] = await Promise.allSettled([
        readIndexRequest(
          () => api.getDocumentMemoryStatus(),
          (v): v is DocumentMemoryStatus =>
            !!v && typeof v === 'object' && typeof (v as DocumentMemoryStatus).enabled === 'boolean',
        ),
        api.getEmbeddingModel ? api.getEmbeddingModel() : Promise.resolve(null),
      ])

      if (memRes.status === 'fulfilled') setMemory(memRes.value)
      if (modelRes.status === 'fulfilled') setModelState(modelRes.value)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [api])

  const profile = modelState?.profile ?? 'standard'
  const activeProfileData = modelState?.profiles?.[profile]

  // Model names
  const modelArchitecture =
    profile === 'high' ? 'Qwen3-Embedding-0.6B (1024D)' : 'F2LLM-v2-80M (768D)'

  return (
    <div className="idx-diagnostics-card" aria-label={isVi ? 'Thông số chẩn đoán' : 'Diagnostics'}>
      <div className="idx-diagnostics-header">
        <div>
          <h4>{isVi ? 'Chẩn đoán kỹ thuật chỉ mục' : 'Index Technical Diagnostics'}</h4>
          <p className="idx-muted">
            {isVi
              ? 'Chi tiết kiến trúc mô hình, vector ANN, bộ nhớ đệm và thông số phần cứng.'
              : 'Details on model architecture, ANN vectors, caching, and hardware metrics.'}
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
              <dd>{activeProfileData?.dimensions ?? (profile === 'high' ? 1024 : 768)}D</dd>
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

        {/* Cache & System Hardware */}
        <div className="idx-diagnostics-section">
          <h5>{isVi ? 'Bộ nhớ đệm & Phần cứng hệ thống' : 'Cache & Hardware Specs'}</h5>
          <dl className="idx-diagnostics-dl">
            <div>
              <dt>{isVi ? 'Query Embedding Cache' : 'Query Embedding Cache'}</dt>
              <dd>LRU Memory Cache (Active)</dd>
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
    </div>
  )
}
