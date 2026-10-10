import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocumentText } from '../src/main/document-memory/chunks'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { storageBudgetAckReply } from './helpers/storage-budget-ack'

let dir: string
let manager: DocumentMemoryManager | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-stall-'))
})
afterEach(async () => {
  await manager?.closeAsync()
  manager = undefined
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A worker that accepts requests and never answers them, like a parser stuck in a native call.
 * It still answers the startup storage-budget handshake so the manager is write-ready.
 */
class StuckWorker extends EventEmitter {
  terminated = false
  postMessage(message: { id?: number; type?: string }): void {
    const ack = storageBudgetAckReply(message)
    if (ack) this.emit('message', ack)
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}

class HealthyWorker extends EventEmitter {
  postMessage(message: { id: number; type: string; path?: string; texts?: string[] }): void {
    setTimeout(() => {
      const ack = storageBudgetAckReply(message)
      if (ack) {
        this.emit('message', ack)
        return
      }
      if (message.type === 'extract') {
        const bytes = readFileSync(message.path!)
        const stat = statSync(message.path!)
        this.emit('message', {
          id: message.id,
          result: {
            hash: createHash('sha256').update(bytes).digest('hex'),
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
            chunks: chunkDocumentText(bytes.toString('utf8')),
            status: 'text-only',
          },
        })
      } else {
        this.emit('message', { type: 'model', state: 'ready' })
        this.emit('message', {
          id: message.id,
          result: (message.texts ?? []).map(() =>
            new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1),
          ),
        })
      }
    }, 0)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('worker stall recovery', () => {
  it('restarts a silent worker and keeps indexing the files queued behind it', async () => {
    const stuck = new StuckWorker()
    let created = 0
    manager = new DocumentMemoryManager(join(dir, 'user'), {
      workerFactory: () => (++created === 1 ? stuck : new HealthyWorker()) as unknown as Worker,
      pollIntervalMs: 3_600_000,
      workerTimeoutMs: 150,
    })
    const first = join(dir, 'first.txt')
    const second = join(dir, 'second.txt')
    writeFileSync(first, 'Biên bản nghiệm thu cầu An Hữu. '.repeat(20))
    writeFileSync(second, 'Hợp đồng thi công đường dẫn vào cầu. '.repeat(20))

    manager.indexDiscoveredFile(first)
    await until(() => stuck.terminated)

    manager.indexDiscoveredFile(second)
    await until(() => manager!.getDocumentIndexProgress(second).state === 'ready')

    expect(created).toBeGreaterThanOrEqual(2)
    expect(manager.getDocumentIndexProgress(first).state).toBe('error')
  })
})
