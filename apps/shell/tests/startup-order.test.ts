import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * main/index.ts cannot be imported in a test (it boots Electron), so the start-up order is pinned on its source.
 *
 * The regression this guards: the shell window was created only after `await ensureDocumentMemoryStorageReady(...)`,
 * and that call migrated / verified the document-memory database synchronously on the main thread. On a multi-gigabyte
 * index nothing could paint for minutes: a white, unresponsive window right after an update (0.11.104).
 */

const source = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
const ready = source.slice(source.indexOf('app.whenReady().then(async () => {'))

describe('main start-up order', () => {
  it('does not import or await the in-process storage bootstrap', () => {
    expect(source).not.toMatch(/import\s*\{[^}]*ensureDocumentMemoryStorageReady[^}]*\}\s*from/)
    expect(source).not.toMatch(/await\s+ensureDocumentMemoryStorageReady/)
  })

  it('starts the bootstrap off the main thread, before the window, without awaiting it', () => {
    const start = ready.indexOf('runStorageBootstrapOffThread(')
    const window = ready.indexOf('createShellWindow()')
    expect(start).toBeGreaterThan(0)
    expect(window).toBeGreaterThan(start)
    expect(ready.slice(Math.max(0, start - 40), start)).not.toMatch(/await\s*$/)
    // nothing between the start of the bootstrap and the window awaits its result
    expect(ready.slice(start, window)).not.toMatch(/await\s+storageBootstrap/)
  })

  it('opens the index only after the bootstrap resolved, and only through attachDocumentMemory', () => {
    const window = ready.indexOf('createShellWindow()')
    const attach = ready.indexOf('attachDocumentMemory(bootstrap')
    expect(attach).toBeGreaterThan(window)
    // the manager is constructed in exactly one place, inside attachDocumentMemory
    expect(source.match(/new DocumentMemoryManager\(/g)).toHaveLength(1)
    const fn = source.slice(source.indexOf('function attachDocumentMemory('))
    expect(fn.indexOf('new DocumentMemoryManager(')).toBeGreaterThan(
      fn.indexOf('if (!bootstrap.ready)'),
    )
  })

  it('keeps the fail-closed branch: a bootstrap that is not ready leaves the index closed', () => {
    const fn = source.slice(
      source.indexOf('function attachDocumentMemory('),
      source.indexOf('let legacyConverter'),
    )
    const notReady = fn.indexOf('if (!bootstrap.ready)')
    const construct = fn.indexOf('new DocumentMemoryManager(')
    expect(notReady).toBeGreaterThan(-1)
    expect(fn.slice(notReady, construct)).toContain('documentMemory = null')
    expect(fn.slice(notReady, construct)).toContain("storageStartup.set('unavailable')")
    expect(fn.slice(notReady, construct)).toContain('return')
  })

  it('starts index-dependent work (converter, folder scans, retention) only once the index is attached', () => {
    const readyBody = ready.slice(0, ready.indexOf("app.on('window-all-closed'"))
    expect(readyBody).not.toContain('startLegacyConverter()')
    expect(readyBody).not.toContain('new FolderScanManager(')
    expect(readyBody).not.toContain('runBackupRetentionMaintenance')
    const fn = source.slice(
      source.indexOf('function attachDocumentMemory('),
      source.indexOf('let legacyConverter'),
    )
    for (const call of [
      'startLegacyConverter()',
      'new FolderScanManager(',
      'runBackupRetentionMaintenance',
    ]) {
      expect(fn, call).toContain(call)
    }
  })

  it('does not open the index when the app is already quitting', () => {
    const fn = source.slice(
      source.indexOf('function attachDocumentMemory('),
      source.indexOf('let legacyConverter'),
    )
    expect(fn).toContain('if (appShuttingDown) return')
  })
})
