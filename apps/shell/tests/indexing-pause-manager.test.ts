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
import {
  isIndexingPaused,
  publishIndexingPolicy,
  resetIndexingPolicyBus,
  type PublishedPolicy,
} from '../src/main/fork/indexing-policy-bus'

const running: PublishedPolicy = {
  paused: false,
  threads: 2,
  cpuShare: 0.5,
  priority: 'below-normal',
  tier: 'active',
  reason: 'test',
  onBattery: false,
}
const paused: PublishedPolicy = {
  ...running,
  paused: true,
  pauseReason: 'battery-saver',
  cpuShare: 0,
  tier: 'paused',
  onBattery: true,
}

class FakeWorker extends EventEmitter {
  extractions: string[] = []
  embeddings: string[][] = []
  constructor(
    private readonly delay: number,
    private readonly onRequest: (type: string) => void = () => {},
  ) {
    super()
  }
  postMessage(message: { id: number; type: string; path?: string; texts?: string[] }) {
    this.onRequest(message.type)
    setTimeout(() => {
      if (message.type === 'extract') {
        this.extractions.push(message.path!)
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
      } else if (message.type === 'embed') {
        this.embeddings.push(message.texts ?? [])
        this.emit('message', { type: 'model', state: 'ready' })
        this.emit('message', {
          id: message.id,
          result: (message.texts ?? []).map(() => new Array(EMBEDDING_PROFILES.standard.dimensions).fill(0.1)),
        })
      }
    }, this.delay)
  }
  terminate() {
    return Promise.resolve(0)
  }
}

let dir: string
let manager: DocumentMemoryManager | null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'indexing-pause-'))
  manager = null
  resetIndexingPolicyBus()
})
afterEach(() => {
  manager?.close()
  rmSync(dir, { recursive: true, force: true })
  resetIndexingPolicyBus()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, timeout = 4000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out')
    await sleep(10)
  }
}
function create(fake: FakeWorker) {
  manager = new DocumentMemoryManager(dir, {
    pollIntervalMs: 60_000,
    workerFactory: () => fake as unknown as Worker,
  })
  return manager
}

describe('document index pause', () => {
  it('takes no new work while paused and resumes by itself', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'alpha beta gamma delta '.repeat(20))
    publishIndexingPolicy(paused)
    expect(isIndexingPaused()).toBe(true)
    const fake = new FakeWorker(0)
    const instance = create(fake)
    expect(instance.indexDiscoveredFile(file)).toBe(true)
    await sleep(150)
    expect(fake.extractions).toEqual([])
    expect(fake.embeddings).toEqual([])
    expect(instance.indexingActivityStatus().pending).toBe(1)

    publishIndexingPolicy(running)
    await until(() => instance.status().vectors > 0 && instance.status().pending === 0)
    expect(fake.extractions).toEqual([file])
  })

  it('finishes the step in flight, then stops pulling work until resumed', async () => {
    const first = join(dir, 'one.txt')
    const second = join(dir, 'two.txt')
    writeFileSync(first, 'one one one one '.repeat(30))
    writeFileSync(second, 'two two two two '.repeat(30))
    let requests = 0
    // The policy flips to paused the moment the first extraction is requested (mid-step).
    const fake = new FakeWorker(80, (type) => {
      if (type === 'extract' && ++requests === 1) publishIndexingPolicy(paused)
    })
    const instance = create(fake)
    instance.indexDiscoveredFile(first)
    instance.indexDiscoveredFile(second)
    await sleep(500)
    // The in-flight extraction was allowed to finish and be stored; nothing new started.
    expect(fake.extractions).toEqual([first])
    expect(fake.embeddings).toEqual([])
    expect(instance.status().documents).toBeGreaterThanOrEqual(1)

    publishIndexingPolicy(running)
    await until(() => instance.status().vectors > 0 && instance.status().pending === 0, 8000)
    expect(fake.extractions).toEqual([first, second])
  })

  it('does not subscribe after close', async () => {
    const instance = create(new FakeWorker(0))
    instance.close()
    expect(() => publishIndexingPolicy(running)).not.toThrow()
  })
})
