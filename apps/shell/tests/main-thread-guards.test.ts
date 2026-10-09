import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string =>
  readFileSync(join(__dirname, '..', 'src', 'main', rel), 'utf8')

/**
 * Source pins for the "nothing heavy on Electron's main thread" rule: each of these calls is a full pass over a large
 * table (or a whole index) and used to sit in a handler or timer that runs on the UI thread.
 */
describe('main-thread guards', () => {
  it('the manager never purges junk itself', () => {
    const manager = read('document-memory/manager.ts')
    expect(manager).not.toMatch(/purgeJunkOnce|purgeDiscoveredByName\(/)
    expect(manager).toContain('startJunkPurge')
  })

  it('the file search handler asks the search thread, not the store', () => {
    const index = read('index.ts')
    expect(index).not.toMatch(/fileIndexStore!?\.search\(/)
    expect(index).toContain('fileSearch.search(')
  })

  it('the snapshot, folder-count and issue-summary handlers read the aggregates, not the tables', () => {
    expect(read('fork/document-index-snapshot-service.ts')).toContain('aggregates')
    expect(read('fork/document-index-folder-handlers.ts')).toContain('aggregates.folder(')
    expect(read('fork/document-index-ipc.ts')).toContain('aggregates.issues(')
    expect(read('fork/document-index-ipc.ts')).toContain('aggregates.searchIndexed(')
    expect(read('index.ts')).toContain('aggregates.legacyPaths(')
    expect(read('index.ts')).toContain('aggregates.stats()')
  })

  it('the lag watchdog is started at launch', () => {
    expect(read('index.ts')).toMatch(/startLoopWatchdogToFile\(/)
  })

  it('the new-file enrollment does not look documents up by hash without a size probe', () => {
    const freshness = read('document-memory/runtime/freshness-coordinator.ts')
    expect(freshness).toContain('hasOtherDocumentOfSize')
  })
})
