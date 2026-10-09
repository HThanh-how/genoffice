// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import { IndexStorageSettings } from '../src/renderer/src/fork/IndexStorageSettings'
import { appConfirm } from '../src/renderer/src/ui-feedback'
import { quotaString, type QuotaStringKey } from '../src/renderer/src/fork/storage-quota-i18n'
import { LocaleProvider } from '../src/renderer/src/locale'
import type {
  DocumentIndexBackupDeleteResult,
  DocumentIndexBackupInfo,
  StorageBudgetConfig,
  StorageBudgetSnapshot,
} from '../src/shared/fork/document-index-api'
import type { HomeApi } from '../src/shared/home-api'

vi.mock('../src/renderer/src/ui-feedback', () => ({ appConfirm: vi.fn(async () => true) }))

const GB = 1_000_000_000
let container: HTMLDivElement
let root: Root

function snapshot(over: Partial<StorageBudgetSnapshot> = {}): StorageBudgetSnapshot {
  return {
    databaseBytes: 600_000_000, budgetBytes: 3 * GB, usageRatio: 0.2, chunksBytes: 0, embeddingsBytes: 0, ftsBytes: 0, ocrBytes: 0,
    backupBytes: 0, reclaimableBytes: 0, limitState: 'ok', totalManagedBytes: 600_000_000, softBudgetBytes: 3 * GB, hardCapBytes: 3.3 * GB,
    graceActive: false, overQuotaBytes: 0, ...over,
  }
}

function config(over: Partial<StorageBudgetConfig> = {}): StorageBudgetConfig {
  return { maxDatabaseBytes: 3 * GB, preset: '3gb', version: 4, appliedVersion: 4, status: 'applied', ...over }
}

function makeApi(opts: { config?: StorageBudgetConfig; snapshot?: StorageBudgetSnapshot; dimensions?: number; totalMemGiB?: number; set?: HomeApi['setStorageBudgetSettings'] } = {}) {
  const set =
    opts.set ??
    vi.fn(async (input: any) => ({
      ok: true,
      settings: config({ maxDatabaseBytes: input.maxDatabaseBytes, preset: input.preset, version: 5, appliedVersion: 5 }),
    }))
  return {
    api: {
      getStorageBudgetSettings: vi.fn(async () => opts.config ?? config()),
      setStorageBudgetSettings: set,
      getDocumentIndexStorageBudget: vi.fn(async () => opts.snapshot ?? snapshot()),
      getEmbeddingModel: vi.fn(async () => ({
        profile: 'standard', recommended: 'standard', machine: { totalMemGiB: opts.totalMemGiB ?? 16, logicalCores: 8 },
        profiles: { standard: { name: 'Standard', dimensions: opts.dimensions ?? 320, downloadMB: 1, memoryMB: 1 }, high: { name: 'High', dimensions: 512, downloadMB: 1, memoryMB: 1 } },
      })),
    } as unknown as HomeApi,
    set: set as ReturnType<typeof vi.fn>,
  }
}

async function render(api: HomeApi, lang: Lang = 'vi') {
  await act(async () => root.render(createElement(LocaleProvider, { initial: lang, children: createElement(IndexStorageSettings, { api }) })))
}

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.ixq-preset')]
const presetButton = (label: string) => buttons().find((b) => b.textContent?.includes(label))!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('IndexStorageSettings (index size)', () => {
  it('shows the three presets in Vietnamese with the current choice pressed, used vs quota and an estimate', async () => {
    const { api } = makeApi()
    await render(api)
    expect(container.textContent).toContain('Dung lượng chỉ mục')
    expect(buttons().map((b) => b.querySelector('strong')?.textContent)).toEqual(['Tiết kiệm', 'Mặc định', 'Cao', 'Tuỳ chỉnh'])
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false'])
    expect(container.textContent).toMatch(/Đã dùng 600 MB \/ 3 GB \(20%\)/)
    expect(container.textContent).toContain('Dành cho máy 4 GB RAM')
    // 3 GB at 40 KB/doc = 75 000 documents; text only at 28 KB/doc = 107 142 -> 107 000, clearly labelled as an estimate
    expect(container.textContent).toMatch(/Ước tính: chứa được khoảng 75[.,\s]?000 tài liệu/)
    expect(container.textContent).toMatch(/khoảng 107[.,\s]?000 nếu chỉ giữ tìm kiếm theo chữ/)
    expect(container.textContent).toContain('Chỉ là ước tính')
    expect(container.textContent).toContain('tạm vượt mức này tối đa 10%')
    expect(container.querySelector('.ixq-chip.ok')?.textContent).toBe('Đã áp dụng')
    expect(container.querySelector('.ixq-alert')).toBeNull()
  })

  it('uses the active embedding profile dimension for the estimate', async () => {
    const { api } = makeApi({ dimensions: 512 })
    await render(api, 'en')
    // 28 000 + 8 x (512 x 4 + 220) = 46 112 bytes per document -> 65 057 -> 65 000
    expect(container.textContent).toMatch(/room for about 65,000 text documents/)
  })

  it('clicking a preset saves it through the live budget API and confirms', async () => {
    const { api, set } = makeApi()
    await render(api)
    await act(async () => presetButton('Tiết kiệm').click())
    expect(set).toHaveBeenCalledExactlyOnceWith({ maxDatabaseBytes: GB, preset: '1gb' })
    expect(container.textContent).toContain('Đã cập nhật dung lượng chỉ mục')
    expect(presetButton('Tiết kiệm').getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toMatch(/khoảng 25[.,\s]?000 tài liệu/)
  })

  it('says it is waiting for the indexer while the worker has not confirmed, and reports a failed apply', async () => {
    const pending = makeApi({ set: vi.fn(async () => ({ ok: false, settings: config({ maxDatabaseBytes: 5 * GB, preset: '5gb', version: 5, appliedVersion: 4, status: 'pending' as const }), error: 'budget-pending-worker-ack' })) })
    await render(pending.api, 'en')
    await act(async () => presetButton('High').click())
    expect(container.textContent).toContain('Saved. Waiting for the indexer to apply it')
    expect(container.querySelector('[role="alert"]')).toBeNull()

    const failed = makeApi({ set: vi.fn(async () => ({ ok: false, settings: config({ version: 5, appliedVersion: null, status: 'error' as const, error: 'boom' }), error: 'boom' })) })
    await render(failed.api, 'en')
    await act(async () => presetButton('Saver').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('boom')
  })

  it('custom size: needs at least 500 MB, never calls the API for an invalid size, saves a valid one', async () => {
    const { api, set } = makeApi()
    await render(api, 'en')
    await act(async () => presetButton('Custom').click())
    const input = container.querySelector<HTMLInputElement>('#ixq-custom-mb')!
    const save = [...container.querySelectorAll<HTMLButtonElement>('.ixq-custom button')][0]!
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await type('499')
    await act(async () => save.click())
    expect(set).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Size must be between 500 MB and 100 GB')
    await type('100001')
    await act(async () => save.click())
    expect(set).not.toHaveBeenCalled()
    await type('2500')
    await act(async () => save.click())
    expect(set).toHaveBeenCalledExactlyOnceWith({ maxDatabaseBytes: 2_500_000_000, preset: 'custom' })
  })

  it('marks the preset suggested for this computer from its RAM', async () => {
    const small = makeApi({ totalMemGiB: 3.7 })
    await render(small.api, 'en')
    expect(presetButton('Saver').textContent).toContain('Suggested for this computer')
    expect(presetButton('Default').textContent).not.toContain('Suggested')
    const big = makeApi({ totalMemGiB: 32 })
    await render(big.api, 'en')
    expect(presetButton('High').textContent).toContain('Suggested for this computer')
  })

  it('grace zone: shows the over-quota hint, still an ordinary status, not an error', async () => {
    const { api } = makeApi({ snapshot: snapshot({ totalManagedBytes: 3.15 * GB, databaseBytes: 3.15 * GB, graceActive: true, overQuotaBytes: 0.15 * GB, limitState: 'warning' }) })
    await render(api, 'en')
    const alert = container.querySelector('.ixq-alert')!
    expect(alert.getAttribute('role')).toBe('status')
    expect(alert.classList.contains('full')).toBe(false)
    expect(alert.textContent).toBe('Over the limit by 150 MB. The index is tidying itself automatically; new files are still being added.')
    expect(container.querySelector('.ixq-bar.over')).not.toBeNull()
  })

  it('hard stop: tells the user the index is full', async () => {
    const { api } = makeApi({ snapshot: snapshot({ totalManagedBytes: 3.4 * GB, graceActive: false, overQuotaBytes: 0.4 * GB, limitState: 'full' }) })
    await render(api, 'en')
    const alert = container.querySelector('.ixq-alert.full')!
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('The index is full')
  })

  it('uses semantic colour tokens only (no raw colours in the panel markup)', async () => {
    const { api } = makeApi()
    await render(api)
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })
})

describe('old index backup (Settings > search index storage)', () => {
  const backupInfo = (over: Partial<DocumentIndexBackupInfo> = {}): DocumentIndexBackupInfo => ({
    exists: true, totalBytes: 5_461_098_496, files: 1, createdAt: 1791535907060, retentionDays: 14, deletable: true, ...over,
  })
  const backupApi = (info: DocumentIndexBackupInfo, del?: () => Promise<DocumentIndexBackupDeleteResult>) => {
    const { api } = makeApi()
    let current = info
    const deleteDocumentIndexBackup = vi.fn(
      del ??
        (async () => {
          current = { ...current, exists: false, totalBytes: 0, files: 0 }
          return { ok: true, freedBytes: 5_461_098_496, deleted: 1 }
        }),
    )
    Object.assign(api as object, { getDocumentIndexBackup: vi.fn(async () => current), deleteDocumentIndexBackup })
    return { api, deleteDocumentIndexBackup }
  }
  const deleteButton = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="index-backup"] button')][0]

  beforeEach(() => vi.mocked(appConfirm).mockClear())

  it('shows nothing when there is no backup', async () => {
    await render(backupApi(backupInfo({ exists: false, totalBytes: 0, files: 0 })).api, 'en')
    expect(container.querySelector('[data-testid="index-backup"]')).toBeNull()
  })

  it('shows the size, the keep period and a delete button that names the space it frees', async () => {
    await render(backupApi(backupInfo()).api, 'en')
    const box = container.querySelector('[data-testid="index-backup"]')!
    expect(box.textContent).toContain('Old index backup')
    expect(box.textContent).toContain('5.46 GB')
    expect(box.textContent).toContain('after 14 days')
    expect(deleteButton().textContent).toBe('Delete old index backup (frees 5.46 GB)')
    expect(deleteButton().disabled).toBe(false)
  })

  it('asks for confirmation first; declining deletes nothing', async () => {
    vi.mocked(appConfirm).mockResolvedValueOnce(false)
    const { api, deleteDocumentIndexBackup } = backupApi(backupInfo())
    await render(api, 'en')
    await act(async () => deleteButton().click())
    expect(appConfirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appConfirm).mock.calls[0][0]).toContain('free 5.46 GB')
    expect(vi.mocked(appConfirm).mock.calls[0][1]).toMatchObject({ tone: 'danger', confirmLabel: 'Delete backup' })
    expect(deleteDocumentIndexBackup).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="index-backup"]')).not.toBeNull()
  })

  it('confirming deletes, reports the freed space and removes the row', async () => {
    const { api, deleteDocumentIndexBackup } = backupApi(backupInfo())
    await render(api, 'en')
    await act(async () => deleteButton().click())
    expect(deleteDocumentIndexBackup).toHaveBeenCalledTimes(1)
    const box = container.querySelector('[data-testid="index-backup"]')!
    expect(box.textContent).toContain('Old index backup deleted. Freed 5.46 GB.')
    expect(box.querySelector('button')).toBeNull()
  })

  it('cannot be deleted while an upgrade is unfinished (button disabled, reason shown)', async () => {
    const { api, deleteDocumentIndexBackup } = backupApi(backupInfo({ deletable: false }))
    await render(api, 'en')
    expect(deleteButton().disabled).toBe(true)
    expect(container.querySelector('[data-testid="index-backup"]')!.textContent).toContain('cannot be deleted right now')
    await act(async () => deleteButton().click())
    expect(deleteDocumentIndexBackup).not.toHaveBeenCalled()
  })

  it('shows a failure instead of claiming success, and keeps the backup listed', async () => {
    const { api } = backupApi(backupInfo(), async () => ({ ok: false, freedBytes: 0, deleted: 0, error: 'a.db: EBUSY' }))
    await render(api, 'en')
    await act(async () => deleteButton().click())
    const alert = container.querySelector('[data-testid="index-backup"] [role="alert"]')!
    expect(alert.textContent).toBe('Could not delete the backup: a.db: EBUSY')
    expect(deleteButton()).toBeTruthy()
  })

  it('works in Vietnamese', async () => {
    await render(backupApi(backupInfo()).api, 'vi')
    expect(deleteButton().textContent).toBe('Xoá bản sao lưu chỉ mục cũ (giải phóng 5,46 GB)')
  })
})

const KEYS: QuotaStringKey[] = [
  'title', 'hint', 'presetSaver', 'presetDefault', 'presetHigh', 'presetCustom', 'forRam', 'recommended', 'customLabel', 'save', 'saved',
  'savedPending', 'invalid', 'used', 'estimate', 'estimateLexical', 'estimateNote', 'grace', 'graceActive', 'full', 'lowerNote',
  'statusApplied', 'statusPending', 'statusError', 'backupTitle', 'backupText', 'backupDelete', 'backupConfirm', 'backupConfirmLabel',
  'backupDeleted', 'backupFailed', 'backupBlocked',
]
const raw = (lang: Lang, key: QuotaStringKey) => quotaString(lang, key) // unfilled: placeholders stay visible

describe('index size strings in every locale', () => {
  it('all 21 locales define every key, with the same placeholders as Chinese (the key-set owner)', () => {
    expect(LANGS).toHaveLength(21)
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',')
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(raw(lang, key), `${lang}.${key}`).toBeTruthy()
        expect(placeholders(raw(lang, key)), `${lang}.${key}`).toBe(placeholders(raw('zh', key)))
      }
    }
  })

  it('every locale keeps the 500 MB / 100 GB bounds and the 10% grace figure the code enforces', () => {
    for (const lang of LANGS) {
      expect(raw(lang, 'invalid'), lang).toMatch(/500/)
      expect(raw(lang, 'invalid'), lang).toMatch(/100/)
      expect(raw(lang, 'grace'), lang).toMatch(/10/)
      expect(raw(lang, 'customLabel'), lang).toMatch(/500/)
    }
  })
})
