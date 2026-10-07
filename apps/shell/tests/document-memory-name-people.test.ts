import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'

class QuietWorker extends EventEmitter {
  postMessage(message: { id: number; type: string; texts?: string[] }): void {
    setTimeout(() => {
      this.emit('message', { type: 'model', state: 'ready' })
      this.emit('message', {
        id: message.id,
        result: (message.texts ?? []).map(() => new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1)),
      })
    }, 0)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

let dir: string
let manager: DocumentMemoryManager
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-people-'))
  manager = new DocumentMemoryManager(join(dir, 'user'), {
    workerFactory: () => new QuietWorker() as unknown as Worker,
    pollIntervalMs: 3_600_000,
    // hold every file back: these are name-only lookups, as for a scan waiting its turn
    autoDeferAfterMs: 3_600_000,
  })
  manager.setEnabled(false)
})
afterEach(() => {
  manager.close()
  rmSync(dir, { recursive: true, force: true })
})

function file(...parts: string[]): string {
  const path = join(dir, ...parts)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
  return path
}

const names = (hits: Array<{ path: string }>): string[] =>
  hits.map((hit) => hit.path.slice(dir.length + 1).replace(/\\/g, '/'))

describe("finding a person's paper by its kind and the person's name", () => {
  const seed = (): void => {
    for (const path of [
      file('huucong', 'giay ra vien.pdf'),
      file('other', 'pham huu cong.pdf'),
      file('huucong', 'hop dong lao dong.docx'),
      file('ho so', 'giay ra vien nguyen van a.pdf'),
      file('ho so', 'giay ra vien pham van b.pdf'),
      file('ho so', 'cong van so 12.pdf'),
    ])
      manager.indexDiscoveredFile(path)
  }

  it('puts the discharge paper in the folder named after the person first', async () => {
    seed()
    for (const query of [
      'tôi tìm file giấy ra viện của ông phạm hữu công',
      'giay ra vien pham huu cong',
      'giấy ra viện Phạm Hữu Công',
    ]) {
      const { hits } = await manager.search(query, 8)
      expect(names(hits)[0], query).toBe('huucong/giay ra vien.pdf')
    }
  })
})
