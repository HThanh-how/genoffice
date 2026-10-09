import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerDocumentIndexStorageHandlers } from '../src/main/fork/document-index-storage-handlers'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { writeBackupRetentionDays } from '../src/main/document-memory/storage/migration/backup-retention-settings'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'

const NAME = 'document-memory.db.v2.1791535907060.e37993d1.backup.db'

describe('old index backup IPC (Settings > search index storage)', () => {
  let dir: string
  let handlers: Map<string, (event: unknown, input?: unknown) => Promise<any>>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dm-backup-ipc-'))
    new DocumentMemoryStore(join(dir, 'document-memory.db')).close()
    handlers = new Map()
    registerDocumentIndexStorageHandlers({
      ipcMain: { handle: (channel: string, fn: any) => handlers.set(channel, fn) },
      getDocumentMemory: () => null,
      dbPath: () => join(dir, 'document-memory.db'),
      settingsPath: () => join(dir, 'app-settings.json'),
    } as any)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const info = () => handlers.get(DOCUMENT_INDEX_CHANNELS.getDocumentIndexBackup)!({})
  const del = () => handlers.get(DOCUMENT_INDEX_CHANNELS.deleteDocumentIndexBackup)!({})

  it('reports no backup on a clean install', async () => {
    expect(await info()).toMatchObject({
      exists: false,
      totalBytes: 0,
      files: 0,
      deletable: false,
      retentionDays: 14,
    })
  })

  it('reports the real size and age of the backup and honours the configured retention period', async () => {
    writeFileSync(join(dir, NAME), '')
    truncateSync(join(dir, NAME), 5_461_098_496)
    writeBackupRetentionDays(dir, 30)
    expect(await info()).toMatchObject({
      exists: true,
      totalBytes: 5_461_098_496,
      files: 1,
      createdAt: 1791535907060,
      retentionDays: 30,
      deletable: true,
    })
  })

  it('deletes the backup, returns the freed bytes and leaves the live index and user files in place', async () => {
    writeFileSync(join(dir, NAME), Buffer.alloc(3000))
    writeFileSync(join(dir, 'report.docx'), 'user document')
    const result = await del()
    expect(result).toEqual({ ok: true, freedBytes: 3000, deleted: 1 })
    expect(existsSync(join(dir, NAME))).toBe(false)
    expect(existsSync(join(dir, 'document-memory.db'))).toBe(true)
    expect(existsSync(join(dir, 'report.docx'))).toBe(true)
    expect((await info()).exists).toBe(false)
  })

  it('is not deletable, and refuses to delete, while a migration is unfinished', async () => {
    writeFileSync(join(dir, NAME), Buffer.alloc(3000))
    writeFileSync(
      join(dir, 'document-memory.migration-state.json'),
      JSON.stringify({ phase: 'source-backed-up' }),
    )
    expect((await info()).deletable).toBe(false)
    expect(await del()).toEqual({
      ok: false,
      freedBytes: 0,
      deleted: 0,
      error: 'migration-in-flight',
    })
    expect(existsSync(join(dir, NAME))).toBe(true)
  })

  it('concurrent delete requests share one run', async () => {
    writeFileSync(join(dir, NAME), Buffer.alloc(3000))
    const [a, b] = await Promise.all([del(), del()])
    expect(a).toEqual(b)
    expect(a.deleted).toBe(1)
  })
})
