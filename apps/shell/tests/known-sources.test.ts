import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KNOWN_SOURCES,
  FAST_RETRY_INTERVALS_MS,
  KNOWN_SEARCH_SOURCES,
  KNOWN_SEARCH_SOURCES_INITIALIZED_KEY,
  KNOWN_SEARCH_SOURCES_KEY,
  KNOWN_SEARCH_SOURCES_VERSION_KEY,
  KnownSourcesManager,
  PROBE_PATH_DEADLINE_MS,
  SLOW_PERIODIC_RETRY_INTERVAL_MS,
  UNINITIALIZED_KNOWN_SOURCES,
  isKnownSearchSource,
  parseKnownSourcesFullSettings,
  parseKnownSourcesSettings,
  probePathAvailable,
  type KnownSearchSource,
} from '../src/main/document-memory/known-sources'
import { FolderScanManager } from '../src/main/document-memory/folder-scan'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import { DOCUMENT_INDEX_CHANNELS, type KnownSearchSourceEntry } from '../src/shared/fork/document-index-api'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('KnownSourcesManager and Known Search Sources IPC', () => {
  let testDir: string
  let settingsFile: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'known-sources-test-'))
    settingsFile = join(testDir, 'app-settings.json')
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('Path Resolution and Fallback Safety', () => {
    it('resolves valid known sources to homedir subfolders when app.getPath is unavailable', () => {
      const manager = new KnownSourcesManager()

      const docs = manager.resolvePath('documents')
      const downloads = manager.resolvePath('downloads')
      const desktop = manager.resolvePath('desktop')

      expect(docs).toBe(resolve(join(homedir(), 'Documents')))
      expect(downloads).toBe(resolve(join(homedir(), 'Downloads')))
      expect(desktop).toBe(resolve(join(homedir(), 'Desktop')))
    })

    it('resolves using custom path resolver when supplied', () => {
      const customPaths: Record<KnownSearchSource, string> = {
        documents: join(testDir, 'CustomDocs'),
        downloads: join(testDir, 'CustomDownloads'),
        desktop: join(testDir, 'CustomDesktop'),
      }
      const manager = new KnownSourcesManager({
        getPath: (id) => customPaths[id],
      })

      expect(manager.resolvePath('documents')).toBe(resolve(customPaths.documents))
      expect(manager.resolvePath('downloads')).toBe(resolve(customPaths.downloads))
      expect(manager.resolvePath('desktop')).toBe(resolve(customPaths.desktop))
    })

    it('strictly rejects arbitrary or malicious path strings as source ids', () => {
      const manager = new KnownSourcesManager()

      const maliciousInputs = [
        'C:\\Windows\\System32',
        '/etc/passwd',
        '../../secret',
        'custom_folder',
        '',
        'null',
        'undefined',
      ]

      for (const input of maliciousInputs) {
        expect(isKnownSearchSource(input)).toBe(false)
        expect(() => manager.resolvePath(input as KnownSearchSource)).toThrow(
          'Invalid known search source id',
        )
      }
    })
  })

  describe('Initialization, Privacy & State (Mission A2)', () => {
    it('A-02: Profile cũ uninitialized -> không silent scan và runtime enabled = false', async () => {
      // Giả lập profile cũ chỉ có cấu hình theme/language, chưa từng khởi tạo known search sources
      writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', language: 'vi' }))

      const startMock = vi.fn()
      const mockScanner = {
        start: startMock,
        unregisterRoot: vi.fn(),
        status: vi.fn().mockReturnValue({ running: false }),
        folders: vi.fn().mockReturnValue([]),
      }

      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
        scanner: mockScanner as any,
      })

      expect(manager.isInitialized()).toBe(false)
      const sources = await manager.getKnownSearchSources()
      // Tất cả source phải ở trạng thái enabled: false
      for (const source of sources) {
        expect(source.enabled).toBe(false)
        expect(source.status).toBe('disabled')
      }

      // Reconcile không được gọi scan bất kỳ thư mục nào
      await manager.reconcileDesiredSources()
      expect(startMock).not.toHaveBeenCalled()
    })

    it('A-01: Startup với Downloads=true -> tự động reconcile scanner', async () => {
      const downloadsDir = join(testDir, 'Downloads')
      mkdirSync(downloadsDir, { recursive: true })

      writeFileSync(
        settingsFile,
        JSON.stringify({
          [KNOWN_SEARCH_SOURCES_VERSION_KEY]: 1,
          [KNOWN_SEARCH_SOURCES_INITIALIZED_KEY]: true,
          [KNOWN_SEARCH_SOURCES_KEY]: {
            documents: false,
            downloads: true,
            desktop: false,
          },
        }),
      )

      const startMock = vi.fn()
      const mockScanner = {
        start: startMock,
        unregisterRoot: vi.fn().mockResolvedValue(true),
        status: vi.fn().mockReturnValue({ running: false }),
        folders: vi.fn().mockReturnValue([]),
      }

      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
        scanner: mockScanner as any,
        getPath: (id) => (id === 'downloads' ? downloadsDir : join(testDir, id)),
      })

      expect(manager.isInitialized()).toBe(true)
      await manager.reconcileDesiredSources()

      expect(startMock).toHaveBeenCalledWith(resolve(downloadsDir), 'known:downloads')
      expect(startMock).toHaveBeenCalledTimes(1)
    })

    it('defaults to documents: true, downloads: true, desktop: false when profile initialized without keys', async () => {
      writeFileSync(
        settingsFile,
        JSON.stringify({
          [KNOWN_SEARCH_SOURCES_VERSION_KEY]: 1,
          [KNOWN_SEARCH_SOURCES_INITIALIZED_KEY]: true,
        }),
      )

      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
      })

      const sources = await manager.getKnownSearchSources()
      const map = Object.fromEntries(sources.map((s) => [s.id, s.enabled]))
      expect(map).toEqual(DEFAULT_KNOWN_SOURCES)
    })

    it('persists changes with marker to app-settings.json and reloads on new instance', async () => {
      const manager1 = new KnownSourcesManager({
        settingsPath: () => settingsFile,
      })

      // User chủ động kích hoạt -> đánh dấu initialized
      await manager1.setKnownSearchSource('desktop', true)

      const savedJson = JSON.parse(readFileSync(settingsFile, 'utf8'))
      expect(savedJson[KNOWN_SEARCH_SOURCES_INITIALIZED_KEY]).toBe(true)
      expect(savedJson[KNOWN_SEARCH_SOURCES_VERSION_KEY]).toBe(1)
      expect(savedJson[KNOWN_SEARCH_SOURCES_KEY]).toMatchObject({
        desktop: true,
      })

      const manager2 = new KnownSourcesManager({
        settingsPath: () => settingsFile,
      })
      expect(manager2.isInitialized()).toBe(true)
      const sources2 = await manager2.getKnownSearchSources()
      const desktopSource = sources2.find((s) => s.id === 'desktop')
      expect(desktopSource?.enabled).toBe(true)
    })
  })

  describe('Transactional Persistence (Mission A5)', () => {
    it('A-09: Persistence failure -> rollback memory và scanner', async () => {
      const startMock = vi.fn()
      const unregisterMock = vi.fn()
      const mockScanner = {
        start: startMock,
        unregisterRoot: unregisterMock,
        status: vi.fn().mockReturnValue({ running: false }),
        folders: vi.fn().mockReturnValue([]),
      }

      // Đường dẫn file settings không hợp lệ (trỏ vào thư mục không tồn tại và không thể tạo)
      const invalidSettingsFile = join(testDir, 'non_existent_folder', 'deep', 'app-settings.json')

      const manager = new KnownSourcesManager({
        settingsPath: () => invalidSettingsFile,
        scanner: mockScanner as any,
        initialState: { desktop: false },
        initialized: true,
      })

      // Cố gắng bật desktop nhưng ghi đĩa sẽ lỗi
      await expect(manager.setKnownSearchSource('desktop', true)).rejects.toThrow()

      // Trạng thái trong RAM không được phép thay đổi
      const sources = await manager.getKnownSearchSources()
      const desktop = sources.find((s) => s.id === 'desktop')
      expect(desktop?.enabled).toBe(false)

      // Scanner không bao giờ được gọi
      expect(startMock).not.toHaveBeenCalled()
      expect(unregisterMock).not.toHaveBeenCalled()
    })
  })

  describe('Folder Ownership Matrix (Mission A3)', () => {
    it('A-06 & A-07 & A-08: Thư mục trùng giữa manual và known source: bật/tắt cái này không xóa cái kia', async () => {
      const documentsDir = join(testDir, 'Documents')
      mkdirSync(documentsDir, { recursive: true })

      const memory = { indexDiscoveredFile: () => true }
      const scanManager = new FolderScanManager(join(testDir, 'scanner-state'), memory)

      const knownSources = new KnownSourcesManager({
        settingsPath: () => settingsFile,
        scanner: scanManager,
        getPath: () => documentsDir,
      })

      // 1. User add thủ công thư mục Documents ('manual')
      scanManager.start(documentsDir, 'manual')
      let folders = scanManager.folders()
      expect(folders).toHaveLength(1)
      expect(folders[0].owners).toContain('manual')

      // 2. User bật Known Source Documents ('known:documents')
      await knownSources.setKnownSearchSource('documents', true)
      folders = scanManager.folders()
      expect(folders).toHaveLength(1)
      expect(folders[0].owners).toContain('manual')
      expect(folders[0].owners).toContain('known:documents')

      // 3. (A-06) Tắt Known Source Documents: chỉ gỡ owner 'known:documents', root manual vẫn tồn tại!
      await knownSources.setKnownSearchSource('documents', false)
      folders = scanManager.folders()
      expect(folders).toHaveLength(1)
      expect(folders[0].owners).toEqual(['manual'])

      // 4. (A-07) Bật lại Known Source Documents, sau đó xóa manual: root vẫn tồn tại vì known source vẫn bật!
      await knownSources.setKnownSearchSource('documents', true)
      await scanManager.unregisterRoot(documentsDir, 'manual')
      folders = scanManager.folders()
      expect(folders).toHaveLength(1)
      expect(folders[0].owners).toEqual(['known:documents'])

      // 5. (A-08) Tắt nốt Known Source: không còn owner nào -> root mới bị xóa hoàn toàn khỏi manifest!
      await knownSources.setKnownSearchSource('documents', false)
      folders = scanManager.folders()
      expect(folders).toHaveLength(0)

      scanManager.close()
      knownSources.close()
    })
  })

  describe('Canonical Status API (Mission A6) & Bounded Retry (Mission A7)', () => {
    it('returns canonical status: disabled, scanning, queued, unavailable', async () => {
      const existingDir = join(testDir, 'Exists')
      const missingDir = join(testDir, 'MissingDrive', 'Folder')
      mkdirSync(existingDir, { recursive: true })

      const isWaitingMock = vi.fn().mockReturnValue(false)
      const mockScanner = {
        start: vi.fn(),
        unregisterRoot: vi.fn(),
        isWaiting: isWaitingMock,
        status: vi.fn().mockReturnValue({ running: true, root: resolve(existingDir) }),
        folders: vi.fn().mockReturnValue([]),
      }

      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
        scanner: mockScanner as any,
        getPath: (id) => (id === 'documents' ? existingDir : missingDir),
        initialState: {
          documents: true,
          downloads: true,
          desktop: false,
        },
        initialized: true,
      })

      const sources = await manager.getKnownSearchSources()
      const docs = sources.find((s) => s.id === 'documents')
      const downloads = sources.find((s) => s.id === 'downloads')
      const desktop = sources.find((s) => s.id === 'desktop')

      // Desktop: disabled
      expect(desktop?.status).toBe('disabled')

      // Documents: path tồn tại và scanner đang chạy -> scanning
      expect(docs?.status).toBe('scanning')

      // Downloads: path không tồn tại -> unavailable
      expect(downloads?.status).toBe('unavailable')

      // Khi scanner không active root mà đang waiting -> queued
      mockScanner.status.mockReturnValue({ running: true, root: resolve(join(testDir, 'other')) })
      isWaitingMock.mockReturnValue(true)
      const statusQueued = manager.getStatus('documents')
      expect(statusQueued.status).toBe('queued')

      manager.close()
    })
  })

  describe('IPC Channels and Security', () => {
    function setupIpc(manager: KnownSourcesManager) {
      const handlers = new Map<string, Handler>()
      const ipcMain = {
        handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
      }

      registerDocumentIndexIpc({
        ipcMain,
        getDocumentMemory: () => null,
        getFolderScan: () => null,
        dbPath: () => join(testDir, 'test.db'),
        getKnownSources: () => manager,
        settingsPath: () => settingsFile,
      })

      const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
      return { call, handlers }
    }

    it('exposes getKnownSearchSources via IPC and returns valid list with canonical status', async () => {
      const manager = new KnownSourcesManager({ settingsPath: () => settingsFile })
      const { call } = setupIpc(manager)

      const result = (await call(
        DOCUMENT_INDEX_CHANNELS.getKnownSearchSources,
      )) as KnownSearchSourceEntry[]

      expect(result).toHaveLength(3)
      expect(result.map((r) => r.id)).toEqual(KNOWN_SEARCH_SOURCES)
      for (const entry of result) {
        expect(typeof entry.path).toBe('string')
        expect(entry.path.length).toBeGreaterThan(0)
        expect(typeof entry.enabled).toBe('boolean')
        expect(typeof entry.status).toBe('string')
      }
    })

    it('exposes setKnownSearchSource via IPC and enforces valid source id and boolean', async () => {
      const manager = new KnownSourcesManager({ settingsPath: () => settingsFile })
      const { call } = setupIpc(manager)

      // Valid toggle returns entry
      const entry = (await call(
        DOCUMENT_INDEX_CHANNELS.setKnownSearchSource,
        'desktop',
        true,
      )) as KnownSearchSourceEntry
      expect(entry.id).toBe('desktop')
      expect(entry.enabled).toBe(true)

      // Invalid ID: arbitrary path
      await expect(
        call(DOCUMENT_INDEX_CHANNELS.setKnownSearchSource, '/etc/passwd', true),
      ).rejects.toThrow('Invalid known search source id')

      // Invalid ID: arbitrary Windows path
      await expect(
        call(DOCUMENT_INDEX_CHANNELS.setKnownSearchSource, 'C:\\arbitrary\\path', true),
      ).rejects.toThrow('Invalid known search source id')

      // Invalid enabled type
      await expect(
        call(DOCUMENT_INDEX_CHANNELS.setKnownSearchSource, 'documents', 'true'),
      ).rejects.toThrow('Invalid enabled state')
    })
  })

  describe('Audit Fixes: Known Sources Truth & Reconciliation (P0-2, P1, P2)', () => {
    it('KS-01: Enabled + path exists nhưng chưa có job trong scanner -> status KHÔNG PHẢI watching', async () => {
      const docsDir = join(testDir, 'Documents')
      mkdirSync(docsDir, { recursive: true })

      const mockScanner = {
        start: vi.fn(),
        unregisterRoot: vi.fn(),
        status: vi.fn().mockReturnValue({ running: false }),
        folders: vi.fn().mockReturnValue([]),
        isWaiting: vi.fn().mockReturnValue(false),
      }

      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
        scanner: mockScanner as any,
        getPath: () => docsDir,
        initialState: { documents: true, downloads: false, desktop: false },
        initialized: true,
      })

      // Path tồn tại, source bật, nhưng scanner chưa có job -> status KHÔNG ĐƯỢC LÀ 'watching'
      const sources = await manager.getKnownSearchSources()
      const docSource = sources.find((s) => s.id === 'documents')
      expect(docSource?.status).not.toBe('watching')
      expect(docSource?.status).toBe('queued')

      // Trường hợp thư mục có trong scanner nhưng chỉ do user add thủ công (owner: 'manual')
      mockScanner.folders.mockReturnValue([
        {
          root: resolve(docsDir),
          owners: ['manual'],
          state: 'complete',
          discovered: 5,
          enrolled: 5,
          skipped: 0,
          errors: 0,
          history: [],
          priority: false,
        },
      ])

      const sourcesManual = await manager.getKnownSearchSources()
      const docManual = sourcesManual.find((s) => s.id === 'documents')
      expect(docManual?.status).not.toBe('watching')
      expect(docManual?.status).toBe('queued')

      // Chỉ khi job có owner 'known:documents' VÀ state là 'complete' -> mới báo 'watching'
      mockScanner.folders.mockReturnValue([
        {
          root: resolve(docsDir),
          owners: ['manual', 'known:documents'],
          state: 'complete',
          discovered: 5,
          enrolled: 5,
          skipped: 0,
          errors: 0,
          history: [],
          priority: false,
        },
      ])

      const sourcesWatching = await manager.getKnownSearchSources()
      const docWatching = sourcesWatching.find((s) => s.id === 'documents')
      expect(docWatching?.status).toBe('watching')

      manager.close()
    })

    it('KS-02: Source unavailable quá 20s (vượt qua mốc retry cũ), sau đó xuất hiện -> tự động register và chuyển sang watching thành công', async () => {
      vi.useFakeTimers()
      try {
        const remoteDrive = join(testDir, 'RemoteNetworkDrive', 'Documents')

        const startMock = vi.fn()
        const mockFolders: any[] = []
        const mockScanner = {
          start: startMock.mockImplementation((root: string, owner: string) => {
            mockFolders.push({
              root: resolve(root),
              owners: [owner],
              state: 'complete',
              discovered: 2,
              enrolled: 2,
              skipped: 0,
              errors: 0,
              history: [],
              priority: false,
            })
          }),
          unregisterRoot: vi.fn(),
          status: vi.fn().mockReturnValue({ running: false }),
          folders: vi.fn().mockImplementation(() => mockFolders),
          isWaiting: vi.fn().mockReturnValue(false),
        }

        const manager = new KnownSourcesManager({
          settingsPath: () => settingsFile,
          scanner: mockScanner as any,
          getPath: () => remoteDrive,
          initialState: { documents: true, downloads: false, desktop: false },
          initialized: true,
        })

        // Lúc khởi tạo, thư mục mạng chưa tồn tại
        await manager.reconcileDesiredSources()

        expect(startMock).not.toHaveBeenCalled()
        let entry = (await manager.getKnownSearchSources()).find((s) => s.id === 'documents')
        expect(entry?.status).toBe('unavailable')

        // Tua thời gian qua các mốc hồi phục nhanh:
        // Attempt 0: 1.5s
        await vi.advanceTimersByTimeAsync(1600)
        await manager.waitForRetry('documents')
        expect(startMock).not.toHaveBeenCalled()

        // Attempt 1: 5s (tổng cộng 6.6s)
        await vi.advanceTimersByTimeAsync(5100)
        await manager.waitForRetry('documents')
        expect(startMock).not.toHaveBeenCalled()

        // Attempt 2: 15s (tổng cộng 21.7s -> ĐÃ VƯỢT QUÁ MỐC 20S CŨ)
        await vi.advanceTimersByTimeAsync(15100)
        await manager.waitForRetry('documents')
        expect(startMock).not.toHaveBeenCalled()

        // Tại mốc > 20s, ổ đĩa mạng bất ngờ kết nối lại (thư mục được tạo ra)
        mkdirSync(remoteDrive, { recursive: true })

        // Tua thời gian kích hoạt Attempt 3: 60s
        await vi.advanceTimersByTimeAsync(60100)
        await manager.waitForRetry('documents')

        // Hệ thống tự động reconcile và đăng ký scanner thành công mà không cần restart app!
        expect(startMock).toHaveBeenCalledWith(resolve(remoteDrive), 'known:documents')

        // Trạng thái tự động cập nhật sang 'watching'
        entry = (await manager.getKnownSearchSources()).find((s) => s.id === 'documents')
        expect(entry?.status).toBe('watching')

        manager.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('KS-03: scanner.start throw error -> status chuyển sang error hoặc unavailable, retry timer vẫn hoạt động', async () => {
      vi.useFakeTimers()
      try {
        const docsDir = join(testDir, 'DocsWithFailure')
        mkdirSync(docsDir, { recursive: true })

        const startError = new Error('Disk I/O error or permission denied')
        const startMock = vi.fn().mockImplementation(() => {
          throw startError
        })

        const mockScanner = {
          start: startMock,
          unregisterRoot: vi.fn(),
          status: vi.fn().mockReturnValue({ running: false }),
          folders: vi.fn().mockReturnValue([]),
          isWaiting: vi.fn().mockReturnValue(false),
        }

        const manager = new KnownSourcesManager({
          settingsPath: () => settingsFile,
          scanner: mockScanner as any,
          getPath: () => docsDir,
          initialState: { documents: false, downloads: false, desktop: false },
          initialized: true,
        })

        // Kích hoạt source: scanner.start bị throw ngoại lệ
        await manager.setKnownSearchSource('documents', true)

        expect(startMock).toHaveBeenCalledTimes(1)
        const statusAfterError = manager.getStatus('documents')
        expect(statusAfterError.status).toBe('error')
        expect(statusAfterError.error).toBe('Disk I/O error or permission denied')

        // Kiểm tra retry timer vẫn hoạt động: sửa lỗi cho scanner.start thành công
        const mockFolders: any[] = []
        startMock.mockImplementation((root: string, owner: string) => {
          mockFolders.push({
            root: resolve(root),
            owners: [owner],
            state: 'complete',
            discovered: 1,
            enrolled: 1,
            skipped: 0,
            errors: 0,
            history: [],
            priority: false,
          })
        })
        mockScanner.folders.mockImplementation(() => mockFolders)

        // Tua fake timer 1.5s để retry tự động chạy
        await vi.advanceTimersByTimeAsync(1600)
        await manager.waitForRetry('documents')

        // Đã retry gọi lại start
        expect(startMock).toHaveBeenCalledTimes(2)

        // Lỗi đã được xóa và trạng thái chuyển sang watching
        const statusRecovered = manager.getStatus('documents')
        expect(statusRecovered.status).toBe('watching')
        expect(statusRecovered.error).toBeUndefined()

        manager.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('KS-04: Async probe không block tiến trình', async () => {
      const probeDir = join(testDir, 'AsyncProbeTest')
      mkdirSync(probeDir, { recursive: true })

      // 1. Path hợp lệ -> trả về true bất đồng bộ
      const exists = await probePathAvailable(probeDir, 3000)
      expect(exists).toBe(true)

      // 2. Path không tồn tại -> trả về false bất đồng bộ
      const nonExistent = await probePathAvailable(join(testDir, 'non_existent_folder'), 3000)
      expect(nonExistent).toBe(false)

      // 3. Deadline timeout bảo vệ main thread: deadline ngắn kết thúc an toàn
      const startMs = Date.now()
      const timeoutProbe = await probePathAvailable(join(testDir, 'timeout_check'), 50)
      const durationMs = Date.now() - startMs
      expect(timeoutProbe).toBe(false)
      expect(durationMs).toBeLessThan(1000)

      // 4. Đảm bảo event loop không bị block
      let immediateFired = false
      setImmediate(() => {
        immediateFired = true
      })
      await probePathAvailable(probeDir)
      expect(immediateFired).toBe(true)
    })
  })
})

