import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { verifyModel } from '../src/integrity'
import { contextBudget } from '../src/budget'
import { LFM_MANIFEST, modelUrl } from '../src/manifest'
import { validateLocalToolCall, localOptions } from '../src/protocol'

describe('pinned integrity and policy', () => {
  it('rehashes same-size, same-mtime content even with a stale marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lfm-integrity-'))
    try {
      const path = join(dir, 'model.gguf')
      const file = { bytes: 4, sha256: createHash('sha256').update('good').digest('hex') }
      await writeFile(path, 'good')
      await verifyModel(path, undefined, file)
      const before = await stat(path)
      await writeFile(`${path}.verified`, `${file.sha256}:4`)
      await writeFile(path, 'evil')
      await utimes(path, before.atime, before.mtime)
      await expect(verifyModel(path, undefined, file)).rejects.toMatchObject({
        code: 'MODEL_CHECKSUM',
      })
      await writeFile(path, 'x')
      await expect(verifyModel(path, undefined, file)).rejects.toMatchObject({ code: 'MODEL_SIZE' })
      await expect(verifyModel(join(dir, 'missing'))).rejects.toMatchObject({
        code: 'MODEL_MISSING',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('pins origin, weights and optional projector; never mirrors', () => {
    expect(modelUrl()).toContain(`/resolve/${LFM_MANIFEST.revision}/`)
    expect(LFM_MANIFEST.mirrorable).toBe(false)
    expect(LFM_MANIFEST.files[1]).toMatchObject({ optional: true, purpose: 'vision' })
    expect(localOptions()).toMatchObject({ gpu: 'cpu', thinking: false, keepHotMinutes: 10 })
  })
  it('budgets memory and refuses insufficient RAM', () => {
    const gib = 1024 ** 3
    expect(() => contextBudget(gib, 8 * gib)).toThrow()
    // a long agent prompt needs more than 4096 tokens, so even a tight machine gets 8192
    expect(contextBudget(2.6 * gib, 8 * gib)).toBe(8192)
    expect(contextBudget(3 * gib, 8 * gib)).toBe(16384)
    expect(contextBudget(8 * gib, 16 * gib)).toBe(16384)
    expect(contextBudget(16 * gib, 32 * gib, 32768)).toBe(32768)
  })
  it('rejects tools outside the grant and deletion without target without changing arguments', () => {
    const call = { id: '1', name: 'deleteBlocks', input: {} }
    expect(() => validateLocalToolCall(call, [])).toThrow('not granted')
    expect(() =>
      validateLocalToolCall(call, [{ name: call.name, description: '', inputSchema: {} }]),
    ).toThrow('explicit target')
    expect(call.input).toEqual({})
    expect(() =>
      validateLocalToolCall({ ...call, input: { target: ['b1'] } }, [
        { name: call.name, description: '', inputSchema: {} },
      ]),
    ).toThrow('explicit target')
  })
})
