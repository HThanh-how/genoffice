import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KNOWN_SOURCES,
  KNOWN_SEARCH_SOURCES,
  KNOWN_SEARCH_SOURCES_KEY,
  KnownSourcesManager,
  isKnownSearchSource,
  parseKnownSourcesSettings,
  type KnownSearchSource,
} from '../src/main/document-memory/known-sources'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'

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

  describe('State and Persistence', () => {
    it('defaults to documents: true, downloads: true, desktop: false', async () => {
      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
      })

      const sources = await manager.getKnownSearchSources()
      expect(sources).toHaveLength(3)

      const map = Object.fromEntries(sources.map((s) => [s.id, s.enabled]))
      expect(map).toEqual({
        documents: true,
        downloads: true,
        desktop: false,
      })
    })

    it('persists changes to app-settings.json and reloads on new instance', async () => {
      const manager1 = new KnownSourcesManager({
        settingsPath: () => settingsFile,
      })

      // Toggle desktop on and documents off
      await manager1.setKnownSearchSource('desktop', true)
      await manager1.setKnownSearchSource('documents', false)

      const savedJson = JSON.parse(readFileSync(settingsFile, 'utf8'))
      expect(savedJson[KNOWN_SEARCH_SOURCES_KEY]).toEqual({
        documents: false,
        downloads: true,
        desktop: true,
      })

      // New instance reading the same file
      const manager2 = new KnownSourcesManager({
        settingsPath: () => settingsFile,
      })
      const sources2 = await manager2.getKnownSearchSources()
      const map2 = Object.fromEntries(sources2.map((s) => [s.id, s.enabled]))
      expect(map2).toEqual({
        documents: false,
        downloads: true,
        desktop: true,
      })
    })

    it('safely handles corrupted or partial settings file with default fallback', () => {
      // Partial settings
      writeFileSync(settingsFile, JSON.stringify({ [KNOWN_SEARCH_SOURCES_KEY]: { desktop: true } }))
      const partialResult = parseKnownSourcesSettings(
        JSON.parse(readFileSync(settingsFile, 'utf8')),
      )
      expect(partialResult).toEqual({
        documents: true,
        downloads: true,
        desktop: true,
      })

      // Corrupted / invalid types
      const invalidResult = parseKnownSourcesSettings({
        [KNOWN_SEARCH_SOURCES_KEY]: {
          documents: 'yes',
          downloads: null,
          desktop: 123,
        },
      })
      expect(invalidResult).toEqual(DEFAULT_KNOWN_SOURCES)
    })
  })

  describe('Scanner Integration', () => {
    it('triggers scanner.start when enabled is true, and scanner.stop/forget when enabled is false', async () => {
      const startMock = vi.fn()
      const stopMock = vi.fn()
      const forgetMock = vi.fn()
      const statusMock = vi.fn().mockReturnValue({ running: false, root: null })

      const mockScanner = {
        start: startMock,
        stop: stopMock,
        forget: forgetMock,
        status: statusMock,
        folders: vi.fn().mockReturnValue([]),
      }

      const desktopDir = join(testDir, 'Desktop')
      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
        scanner: mockScanner as any,
        getPath: (id) => (id === 'desktop' ? desktopDir : join(testDir, id)),
      })

      // 1. Enable Desktop -> calls scanner.start
      await manager.setKnownSearchSource('desktop', true)
      expect(startMock).toHaveBeenCalledWith(resolve(desktopDir))

      // 2. Disable Desktop while scanner is reported running for that root
      statusMock.mockReturnValue({ running: true, root: resolve(desktopDir) })
      await manager.setKnownSearchSource('desktop', false)
      expect(stopMock).toHaveBeenCalled()
      expect(forgetMock).toHaveBeenCalledWith(resolve(desktopDir))
    })

    it('syncWithScanner synchronizes all currently enabled sources on startup', async () => {
      const startMock = vi.fn()
      const mockScanner = {
        start: startMock,
        stop: vi.fn(),
        forget: vi.fn(),
        status: vi.fn().mockReturnValue({ running: false }),
        folders: vi.fn().mockReturnValue([]),
      }

      const manager = new KnownSourcesManager({
        settingsPath: () => settingsFile,
        scanner: mockScanner as any,
      })

      await manager.syncWithScanner()
      // By default documents and downloads are enabled, so start should be called for both
      expect(startMock).toHaveBeenCalledTimes(2)
      expect(startMock).toHaveBeenCalledWith(manager.resolvePath('documents'))
      expect(startMock).toHaveBeenCalledWith(manager.resolvePath('downloads'))
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

    it('exposes getKnownSearchSources via IPC and returns valid list', async () => {
      const manager = new KnownSourcesManager({ settingsPath: () => settingsFile })
      const { call } = setupIpc(manager)

      const result = (await call(
        DOCUMENT_INDEX_CHANNELS.getKnownSearchSources,
      )) as Array<{ id: KnownSearchSource; path: string; enabled: boolean }>

      expect(result).toHaveLength(3)
      expect(result.map((r) => r.id)).toEqual(KNOWN_SEARCH_SOURCES)
      for (const entry of result) {
        expect(typeof entry.path).toBe('string')
        expect(entry.path.length).toBeGreaterThan(0)
        expect(typeof entry.enabled).toBe('boolean')
      }
    })

    it('exposes setKnownSearchSource via IPC and enforces valid source id and boolean', async () => {
      const manager = new KnownSourcesManager({ settingsPath: () => settingsFile })
      const { call } = setupIpc(manager)

      // Valid toggle
      await call(DOCUMENT_INDEX_CHANNELS.setKnownSearchSource, 'desktop', true)
      const afterSources = (await call(DOCUMENT_INDEX_CHANNELS.getKnownSearchSources)) as any[]
      expect(afterSources.find((s) => s.id === 'desktop').enabled).toBe(true)

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
})
