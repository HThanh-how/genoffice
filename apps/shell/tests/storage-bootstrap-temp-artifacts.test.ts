import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureDocumentMemoryStorageReady,
  findUnexpectedTempArtifacts,
} from '../src/main/document-memory/storage-bootstrap'

/**
 * A temp file left by the atomic write of ANOTHER setting that lives next to the database must not
 * be mistaken for an unfinished database migration: it used to switch the document memory off on
 * every launch ("Document memory is unavailable (fail-closed): unexpected temporary migration
 * artifacts"), for good, with nothing in the UI saying so.
 */
describe('findUnexpectedTempArtifacts', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-boot-temps-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const touch = (...names: string[]) => {
    for (const name of names) writeFileSync(join(dir, name), 'x')
  }
  const names = (paths: string[]) => paths.map((p) => basename(p)).sort()

  it('ignores the temp file of every other document-memory setting', () => {
    touch(
      'document-memory-folders.json.tmp',
      'document-memory-embedding.json.tmp',
      'document-memory-pdf.json.tmp',
      'document-memory-storage.json.tmp',
      'document-memory-compaction.json.tmp',
      'document-memory.migration-state.json.tmp',
    )
    expect(findUnexpectedTempArtifacts(dir)).toEqual([])
  })

  it.each([
    'document-memory.db.v3.tmp',
    'document-memory.db.v3.tmp.db',
    'document-memory.db.tmp',
    'document-memory.db.migrating',
    'document-memory.db.moving',
    'document-memory.db.v3.tmp-wal',
    'document-memory.db.v3.tmp-shm',
    'document-memory.db-wal.tmp',
  ])('still reports the real migration artifact %s', (name) => {
    touch(name)
    expect(names(findUnexpectedTempArtifacts(dir))).toEqual([name])
  })

  it('reports only the database artifacts when both kinds are present', () => {
    touch(
      'document-memory-folders.json.tmp',
      'document-memory.db',
      'document-memory.db-wal',
      'document-memory.db.migrating',
      'document-memory.json',
    )
    expect(names(findUnexpectedTempArtifacts(dir))).toEqual(['document-memory.db.migrating'])
  })

  it('does not flag the database, its WAL files or a finished backup', () => {
    touch('document-memory.db', 'document-memory.db-wal', 'document-memory.db-shm')
    touch('document-memory.db.v2.1730000000000.backup.db')
    expect(findUnexpectedTempArtifacts(dir)).toEqual([])
  })

  it('follows a custom database name', () => {
    touch('other.db.migrating', 'other-folders.json.tmp', 'document-memory.db.migrating')
    expect(names(findUnexpectedTempArtifacts(dir, 'other.db'))).toEqual(['other.db.migrating'])
  })

  it('returns nothing for a missing folder', () => {
    expect(findUnexpectedTempArtifacts(join(dir, 'does-not-exist'))).toEqual([])
  })
})

describe('ensureDocumentMemoryStorageReady with a leftover setting temp file', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-boot-ready-'))
    mkdirSync(dir, { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts normally when only another setting left a .tmp file behind', async () => {
    writeFileSync(join(dir, 'document-memory-folders.json.tmp'), '{"half":"written"')
    const result = await ensureDocumentMemoryStorageReady(dir)
    expect(result.error).toBeUndefined()
    expect(result.ready).toBe(true)
  })

  it('stays fail-closed for a real unfinished database migration', async () => {
    writeFileSync(join(dir, 'document-memory.db.v3.tmp'), 'staged')
    const result = await ensureDocumentMemoryStorageReady(dir)
    expect(result.ready).toBe(false)
    expect(result.error).toBeDefined()
  })
})
