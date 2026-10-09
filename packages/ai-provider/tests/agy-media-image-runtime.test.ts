import { describe, expect, it } from 'vitest'
import type { AgyRunOptions, AgyRunResult } from '../src/agy-cli'
import { AgyError } from '../src/agy-errors'
import { generateImageWithAgy } from '../src/agy-image'
import type { AgyImageFs } from '../src/agy-image'
import { analyzeMediaWithAgy } from '../src/agy-media'

const CONV = '3c6ebdda-6826-48bc-a7f4-600ad68ec3d1'
const home = '/home/u'
const dir = `${home}/.gemini/antigravity-cli/brain/${CONV}`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const NOW = 1_000_000
const base = { apiKey: '', imageModel: 'gemini-3.7-flash-low', analysisModel: '' }

function fsWith(files: Record<string, Uint8Array>): AgyImageFs {
  const dirs = new Set([dir, `${home}/.gemini/antigravity-cli/brain`])
  return {
    realpath: async (p) => {
      if (p in files || dirs.has(p)) return p
      throw new Error(`ENOENT ${p}`)
    },
    stat: async (p) => {
      const bytes = files[p]
      if (!bytes) throw new Error('ENOENT')
      return { isFile: () => true, size: bytes.byteLength, mtimeMs: NOW }
    },
    readFile: async (p) => {
      const bytes = files[p]
      if (!bytes) throw new Error('ENOENT')
      return bytes
    },
    listFiles: async (d) => Object.keys(files).filter((p) => p.startsWith(`${d}/`)),
  }
}

describe('image generation: --print-timeout expiry', () => {
  it('asks agy for low-risk partial output and the image task effort', async () => {
    let seen: AgyRunOptions | undefined
    await generateImageWithAgy(base, { prompt: 'x' }, undefined, {
      run: async (o) => {
        seen = o
        return { text: `${dir}/a.png`, conversationId: CONV }
      },
      fs: fsWith({ [`${dir}/a.png`]: PNG }),
      home,
      platform: 'linux',
      now: () => NOW,
    })
    expect(seen).toMatchObject({ task: 'image', allowPartial: true })
  })

  it('still returns a picture that was saved before the run was cut off', async () => {
    const blob = await generateImageWithAgy(base, { prompt: 'x' }, undefined, {
      run: async (): Promise<AgyRunResult> => ({ text: '', conversationId: CONV, truncated: true }),
      fs: fsWith({ [`${dir}/saved.png`]: PNG }),
      home,
      platform: 'linux',
      now: () => NOW,
    })
    expect(blob.bytes).toBe(PNG)
  })

  it('reports a time-out (not "could not generate") when nothing was saved', async () => {
    const attempt = generateImageWithAgy(base, { prompt: 'x' }, undefined, {
      run: async (): Promise<AgyRunResult> => ({
        text: 'Working on',
        conversationId: CONV,
        truncated: true,
      }),
      fs: fsWith({}),
      home,
      platform: 'linux',
      now: () => NOW,
    })
    await expect(attempt).rejects.toBeInstanceOf(AgyError)
    await expect(attempt).rejects.toMatchObject({ kind: 'timeout' })
  })
})

describe('media analysis task', () => {
  it('runs as a media task (default effort for reading files)', async () => {
    let seen: AgyRunOptions | undefined
    await analyzeMediaWithAgy(
      { apiKey: '', imageModel: '', analysisModel: '' },
      {
        media: [{ bytes: PNG, mime: 'image/png' }],
        requirements: 'describe',
      },
      undefined,
      {
        run: async (o) => {
          seen = o
          return { text: 'a picture' }
        },
      },
    )
    expect(seen?.task).toBe('media')
  })
})
