import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseAgyStreamLine } from '../src/agy-cli'
import type { AgyRunOptions, AgyRunResult } from '../src/agy-cli'
import {
  AGY_IMAGE_MAX_BYTES,
  agyBrainRoot,
  agyImageFailureMessage,
  buildAgyImagePrompt,
  confineAgyImagePath,
  extractAgyImagePaths,
  generateImageWithAgy,
  isAgyConversationId,
  sniffAgyImageMime,
} from '../src/agy-image'
import type { AgyImageFs } from '../src/agy-image'

const CONV = '3c6ebdda-6826-48bc-a7f4-600ad68ec3d1'
const OTHER_CONV = '0f41aadd-8de9-4e78-9dfb-5a54b48fff13'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])

// Recorded shapes of the verified runs (2026-10, Windows, gemini-3.7-flash-low).
const SUCCESS_RESULT = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: CONV,
    status: 'SUCCESS',
    response: `The image has been generated: C:\\Users\\Admin\\.gemini\\antigravity-cli\\brain\\${CONV}\\red_circle_image_1790848000000.jpg`,
    duration_seconds: 33.9,
    num_turns: 3,
    usage: { input_tokens: 45000, output_tokens: 900, thinking_tokens: 100, total_tokens: 46000 },
  },
})
const DENIED_RESULT = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: CONV,
    status: 'SUCCESS',
    response: '',
    denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
    usage: { input_tokens: 20000, output_tokens: 50, total_tokens: 20050 },
  },
})

interface FakeFile {
  size: number
  mtimeMs: number
  bytes?: Uint8Array
}

/** In-memory fs: `links` maps a path to its real target, files are keyed by real path. */
function fakeFs(files: Record<string, FakeFile>, links: Record<string, string> = {}): AgyImageFs {
  const key = (p: string) => p.toLowerCase()
  const index = new Map(Object.entries(files).map(([p, f]) => [key(p), { p, f }]))
  const linkMap = new Map(Object.entries(links).map(([p, t]) => [key(p), t]))
  const dirs = new Set<string>()
  for (const p of Object.keys(files)) {
    const parts = p.split(/[\\/]/)
    for (let i = 1; i < parts.length; i++)
      dirs.add(key(parts.slice(0, i).join(p.includes('\\') ? '\\' : '/')))
  }
  for (const t of Object.values(links)) dirs.add(key(t))
  const resolve = (p: string): string => {
    const current = p
    // longest link prefix
    for (const [from, to] of linkMap) {
      if (key(current) === from) return to
      if (key(current).startsWith(`${from}\\`) || key(current).startsWith(`${from}/`)) {
        return to + current.slice(from.length)
      }
    }
    return current
  }
  return {
    realpath: async (p) => {
      const real = resolve(p)
      if (!index.has(key(real)) && !dirs.has(key(real))) throw new Error(`ENOENT ${p}`)
      return real
    },
    stat: async (p) => {
      const hit = index.get(key(p))
      if (!hit) throw new Error('ENOENT')
      return { isFile: () => true, size: hit.f.size, mtimeMs: hit.f.mtimeMs }
    },
    readFile: async (p) => {
      const hit = index.get(key(p))
      if (!hit) throw new Error('ENOENT')
      return hit.f.bytes ?? new Uint8Array(hit.f.size)
    },
    listFiles: async (dir) =>
      [...index.values()]
        .map((e) => e.p)
        .filter((p) => key(p).startsWith(`${key(dir)}\\`) || key(p).startsWith(`${key(dir)}/`)),
  }
}

const LAYOUTS = [
  { platform: 'win32' as const, home: 'C:\\Users\\Admin', sep: '\\' },
  { platform: 'darwin' as const, home: '/Users/admin', sep: '/' },
  { platform: 'linux' as const, home: '/home/admin', sep: '/' },
]

describe('agy image generation: prompt', () => {
  it('names the built-in tool, forbids code and asks for the path', () => {
    const prompt = buildAgyImagePrompt({ prompt: 'a red circle' })
    expect(prompt).toContain('Use your built-in image generation tool')
    expect(prompt).toContain('do not write or run any code or shell commands')
    expect(prompt).toContain('generate a red circle.')
    expect(prompt.endsWith('Tell me the file path of the generated image.')).toBe(true)
  })

  it('puts aspect ratio, transparency and references into words', () => {
    expect(buildAgyImagePrompt({ prompt: 'a cat', aspectRatio: '16:9' })).toContain(
      'wide landscape image (16:9',
    )
    expect(buildAgyImagePrompt({ prompt: 'a cat', aspectRatio: '9:16' })).toContain('tall portrait')
    expect(buildAgyImagePrompt({ prompt: 'a cat', aspectRatio: 'auto' })).not.toContain('aspect')
    expect(buildAgyImagePrompt({ prompt: 'a cat', transparent: true })).toContain(
      'plain, uniform, flat white background',
    )
    expect(buildAgyImagePrompt({ prompt: 'a cat' }, ['reference-1.png'])).toContain(
      'reference-1.png',
    )
  })

  it('asks for a single picture and a backdrop the local cutout can remove', () => {
    expect(buildAgyImagePrompt({ prompt: 'a cat' })).toContain('Generate one image only.')
    const transparent = buildAgyImagePrompt({ prompt: 'a cat', transparent: true })
    expect(transparent).toContain('no shadow, gradient, border or texture')
    expect(transparent.endsWith('Tell me the file path of the generated image.')).toBe(true)
  })

  it('collapses newlines and caps very long prompts', () => {
    const prompt = buildAgyImagePrompt({ prompt: `line one\nline two ${'x'.repeat(9000)}` })
    expect(prompt).not.toMatch(/line one\nline two/)
    expect(prompt.length).toBeLessThan(4400)
  })
})

describe('agy image generation: result parsing', () => {
  it('reads the saved path, conversation id and usage from a successful result', () => {
    const event = parseAgyStreamLine(SUCCESS_RESULT)
    expect(event).toMatchObject({ kind: 'result', ok: true, conversationId: CONV })
    expect(event?.kind === 'result' && event.response).toContain('red_circle_image_')
    expect(event?.kind === 'result' && event.deniedActions).toBeUndefined()
  })

  it('reports the empty response and the denied sandbox action', () => {
    const event = parseAgyStreamLine(DENIED_RESULT)
    expect(event).toMatchObject({
      kind: 'result',
      ok: true,
      response: '',
      deniedActions: [{ action: 'command', displayName: 'RunCommand' }],
    })
    const message = agyImageFailureMessage({
      text: '',
      deniedActions: [{ action: 'command', displayName: 'RunCommand' }],
    })
    expect(message).toContain('Antigravity could not generate the image.')
    expect(message).toContain('RunCommand')
    expect(agyImageFailureMessage({ text: '' })).toContain('empty reply')
    expect(agyImageFailureMessage({ text: 'I cannot do that' })).toContain('I cannot do that')
  })

  it('names a rate limit of the image model instead of echoing the reply', () => {
    // recorded from agy 1.3.2 on macOS (2026-10): the image subagent hit HTTP 429 twice
    const reply =
      'The built-in image generation tool was unable to generate the image due to reaching the current model quota/rate limit:\n\n- **Error**: `429 Too Many Requests (RESOURCE_EXHAUSTED / RATE_LIMIT_EXCEEDED)` - Capacity exhausted on the image generation model.'
    const message = agyImageFailureMessage({ text: reply })
    expect(message).toContain('rate limited or out of quota')
    expect(message).toContain('try again')
    expect(message).not.toContain('RESOURCE_EXHAUSTED')
    // a sandbox denial still reports the denied action, whatever the reply says
    expect(
      agyImageFailureMessage({
        text: 'quota',
        deniedActions: [{ action: 'command', displayName: 'RunCommand' }],
      }),
    ).toContain('RunCommand')
  })

  it('reads the conversation id from the init event too', () => {
    expect(
      parseAgyStreamLine(
        JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'm' } }),
      ),
    ).toMatchObject({ kind: 'init', conversationId: CONV })
  })

  it('validates conversation ids as UUIDs', () => {
    expect(isAgyConversationId(CONV)).toBe(true)
    for (const bad of ['', '..', '../x', `${CONV}/..`, 'abc', undefined, 5]) {
      expect(isAgyConversationId(bad)).toBe(false)
    }
  })
})

describe.each(LAYOUTS)('agy brain directory on $platform', ({ platform, home, sep }) => {
  const root = `${home}${sep}.gemini${sep}antigravity-cli${sep}brain`
  const dir = `${root}${sep}${CONV}`
  const good = `${dir}${sep}red_circle.jpg`
  const loc = { home, platform }

  it('lives under the home directory with the same relative layout', () => {
    expect(agyBrainRoot(home, platform)).toBe(root)
  })

  it('extracts the path from the reply, including markdown and file URLs', () => {
    expect(extractAgyImagePaths(`Saved to ${good}.`, dir, platform)).toContain(good)
    expect(extractAgyImagePaths(`![img](${good})`, dir, platform)).toContain(good)
    const url = platform === 'win32' ? `file:///${good.replace(/\\/g, '/')}` : `file://${good}`
    const slashes = (p: string) => p.split('\\').join('/')
    const fromUrl = extractAgyImagePaths(`See [it](${url})`, dir, platform).map(slashes)
    expect(fromUrl).toContain(slashes(good))
  })

  it('accepts a real image inside the conversation folder', async () => {
    const fs = fakeFs({ [good]: { size: 1000, mtimeMs: 1 } })
    await expect(confineAgyImagePath(good, CONV, loc, fs)).resolves.toBe(good)
  })

  it('rejects traversal, other folders, other extensions, oversize, missing and relative paths', async () => {
    const other = `${root}${sep}${OTHER_CONV}${sep}x.png`
    const outside = `${home}${sep}secret.png`
    const fs = fakeFs({
      [good]: { size: 1000, mtimeMs: 1 },
      [`${dir}${sep}notes.txt`]: { size: 10, mtimeMs: 1 },
      [`${dir}${sep}big.png`]: { size: AGY_IMAGE_MAX_BYTES + 1, mtimeMs: 1 },
      [`${dir}${sep}empty.png`]: { size: 0, mtimeMs: 1 },
      [other]: { size: 10, mtimeMs: 1 },
      [outside]: { size: 10, mtimeMs: 1 },
    })
    const fail = (p: string) => expect(confineAgyImagePath(p, CONV, loc, fs)).rejects.toThrow()
    await fail(other)
    await fail(outside)
    await fail(`${dir}${sep}notes.txt`)
    await fail(`${dir}${sep}big.png`)
    await fail(`${dir}${sep}empty.png`)
    await fail(`${dir}${sep}missing.png`)
    await fail('red_circle.jpg')
    await fail('')
    await expect(confineAgyImagePath(good, '../x', loc, fs)).rejects.toThrow(/conversation id/)
  })

  it('rejects a symlink inside the folder that points outside, and a symlinked folder', async () => {
    const outside = `${home}${sep}secret.png`
    const link = `${dir}${sep}link.png`
    const fs = fakeFs(
      { [outside]: { size: 10, mtimeMs: 1 }, [good]: { size: 10, mtimeMs: 1 } },
      { [link]: outside },
    )
    await expect(confineAgyImagePath(link, CONV, loc, fs)).rejects.toThrow(/outside/)
    // brain/<id> itself redirected elsewhere
    const elsewhere = `${home}${sep}Pictures`
    const redirected = fakeFs(
      { [`${elsewhere}${sep}a.png`]: { size: 10, mtimeMs: 1 } },
      { [dir]: elsewhere, [root]: root },
    )
    await expect(
      confineAgyImagePath(`${elsewhere}${sep}a.png`, CONV, loc, redirected),
    ).rejects.toThrow()
  })
})

describe('generateImageWithAgy', () => {
  const home = 'C:\\Users\\Admin'
  const platform = 'win32' as const
  const dir = `${home}\\.gemini\\antigravity-cli\\brain\\${CONV}`
  const base = { apiKey: '', imageModel: 'gemini-3.7-flash-low', analysisModel: '' }
  const run =
    (result: Partial<AgyRunResult>) =>
    async (_o: AgyRunOptions): Promise<AgyRunResult> => ({
      text: '',
      conversationId: CONV,
      ...result,
    })
  const NOW = 1_000_000

  it('returns the bytes of the path named in the reply', async () => {
    const file = `${dir}\\red_circle.jpg`
    const fs = fakeFs({ [file]: { size: JPG.length, mtimeMs: NOW, bytes: JPG } })
    const blob = await generateImageWithAgy(base, { prompt: 'a red circle' }, undefined, {
      run: run({ text: `Done: ${file}` }),
      fs,
      home,
      platform,
      now: () => NOW,
    })
    expect(blob.mime).toBe('image/jpeg')
    expect(blob.bytes).toBe(JPG)
    expect(blob.name).toBe('red_circle.jpg')
  })

  it('passes model, prompt and the long timeout to agy', async () => {
    let seen: AgyRunOptions | undefined
    const file = `${dir}\\a.png`
    const fs = fakeFs({ [file]: { size: PNG.length, mtimeMs: NOW, bytes: PNG } })
    await generateImageWithAgy(base, { prompt: 'x', aspectRatio: '1:1' }, undefined, {
      run: async (o) => {
        seen = o
        return { text: file, conversationId: CONV }
      },
      fs,
      home,
      platform,
      now: () => NOW,
    })
    expect(seen?.model).toBe('gemini-3.7-flash-low')
    expect(seen?.timeoutMs).toBe(240_000)
    expect(seen?.prompt).toContain('square image')
  })

  it('ignores a path the model made up and falls back to the folder scan', async () => {
    const real = `${dir}\\generated.png`
    const outside = 'C:\\Users\\Admin\\Documents\\passwords.png'
    const fs = fakeFs({
      [real]: { size: PNG.length, mtimeMs: NOW + 100, bytes: PNG },
      [outside]: { size: PNG.length, mtimeMs: NOW, bytes: JPG },
    })
    const blob = await generateImageWithAgy(base, { prompt: 'x' }, undefined, {
      run: run({ text: `Saved at ${outside}` }),
      fs,
      home,
      platform,
      now: () => NOW,
    })
    expect(blob.bytes).toBe(PNG)
  })

  it('picks the newest of several attempts and never an attachment mirror', async () => {
    const attempt1 = `${dir}\\attempt-1.jpg`
    const attempt2 = `${dir}\\attempt-2.jpg`
    const mirror = `${dir}\\.tempmediaStorage\\media_1.jpg`
    const fs = fakeFs({
      [attempt1]: { size: JPG.length, mtimeMs: NOW + 100, bytes: JPG },
      [attempt2]: { size: PNG.length, mtimeMs: NOW + 200, bytes: PNG },
      // the mirror of a staged reference is the newest file of all, and still not an output
      [mirror]: {
        size: JPG.length,
        mtimeMs: NOW + 900,
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 9]),
      },
    })
    const blob = await generateImageWithAgy(base, { prompt: 'x' }, undefined, {
      run: run({ text: 'I generated it but forgot the path.' }),
      fs,
      home,
      platform,
      now: () => NOW,
    })
    expect(blob.name).toBe('attempt-2.jpg')
    expect(blob.bytes).toBe(PNG)
  })

  it('never returns a file outside the conversation folder when the folder is empty', async () => {
    const outside = 'C:\\Users\\Admin\\Documents\\passwords.png'
    const fs = fakeFs({
      [outside]: { size: PNG.length, mtimeMs: NOW, bytes: PNG },
      [`${dir}\\transcript.txt`]: { size: 5, mtimeMs: NOW },
    })
    await expect(
      generateImageWithAgy(base, { prompt: 'x' }, undefined, {
        run: run({ text: `Saved at ${outside}` }),
        fs,
        home,
        platform,
        now: () => NOW,
      }),
    ).rejects.toThrow('Antigravity could not generate the image.')
  })

  it('skips images that predate the run and non-image bytes with an image name', async () => {
    const fs = fakeFs({
      [`${dir}\\old.png`]: { size: PNG.length, mtimeMs: NOW - 60_000, bytes: PNG },
      [`${dir}\\fake.png`]: {
        size: 20,
        mtimeMs: NOW + 5,
        bytes: new TextEncoder().encode('not an image at all'),
      },
    })
    await expect(
      generateImageWithAgy(base, { prompt: 'x' }, undefined, {
        run: run({ text: '' }),
        fs,
        home,
        platform,
        now: () => NOW,
      }),
    ).rejects.toThrow(/could not generate/)
  })

  it('turns an empty reply with a denied command into an actionable error', async () => {
    const fs = fakeFs({ [`${dir}\\notes.txt`]: { size: 1, mtimeMs: NOW } })
    await expect(
      generateImageWithAgy(base, { prompt: 'x' }, undefined, {
        run: run({ text: '', deniedActions: [{ action: 'command', displayName: 'RunCommand' }] }),
        fs,
        home,
        platform,
        now: () => NOW,
      }),
    ).rejects.toThrow(/RunCommand.*Settings/s)
  })

  it('rejects a result without a valid conversation id', async () => {
    await expect(
      generateImageWithAgy(base, { prompt: 'x' }, undefined, {
        run: run({ text: 'C:\\x\\a.png', conversationId: '..\\..' }),
        fs: fakeFs({}),
        home,
        platform,
      }),
    ).rejects.toThrow(/could not generate/)
  })

  it('stages reference images next to the prompt', async () => {
    let seen: AgyRunOptions | undefined
    const file = `${dir}\\a.png`
    const fs = fakeFs({ [file]: { size: PNG.length, mtimeMs: NOW, bytes: PNG } })
    await generateImageWithAgy(
      base,
      {
        prompt: 'edit it',
        references: [
          { bytes: PNG, mime: 'image/png' },
          { bytes: JPG, mime: 'application/pdf' },
        ],
      },
      undefined,
      {
        run: async (o) => {
          seen = o
          return { text: file, conversationId: CONV }
        },
        fs,
        home,
        platform,
        now: () => NOW,
      },
    )
    expect(seen?.files?.map((f) => f.name)).toEqual(['reference-1.png'])
    expect(seen?.prompt).toContain('reference-1.png')
  })
})

describe('image magic numbers', () => {
  it('recognises png, jpeg and webp only', () => {
    expect(sniffAgyImageMime(PNG)).toBe('image/png')
    expect(sniffAgyImageMime(JPG)).toBe('image/jpeg')
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
    expect(sniffAgyImageMime(webp)).toBe('image/webp')
    expect(sniffAgyImageMime(new TextEncoder().encode('<svg xmlns=...'))).toBeUndefined()
  })
})

// Real filesystem: realpath, size and symlink handling against an actual temp directory.
describe('confinement on the real filesystem', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-image-test-'))
  const platform = process.platform
  const dir = join(agyBrainRoot(home, platform), CONV)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(home, 'elsewhere'), { recursive: true })
  writeFileSync(join(dir, 'ok.png'), PNG)
  writeFileSync(join(home, 'elsewhere', 'secret.png'), PNG)
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('accepts the real file and rejects .. traversal and missing files', async () => {
    const real = await confineAgyImagePath(join(dir, 'ok.png'), CONV, { home, platform })
    expect(real.toLowerCase().endsWith('ok.png')).toBe(true)
    await expect(
      confineAgyImagePath(join(dir, '..', '..', '..', '..', 'elsewhere', 'secret.png'), CONV, {
        home,
        platform,
      }),
    ).rejects.toThrow(/outside/)
    await expect(
      confineAgyImagePath(join(dir, 'nope.png'), CONV, { home, platform }),
    ).rejects.toThrow()
  })

  it('rejects a symlink to a file outside (skipped where symlinks are not permitted)', async () => {
    try {
      symlinkSync(join(home, 'elsewhere', 'secret.png'), join(dir, 'link.png'), 'file')
    } catch {
      return // Windows without developer mode: cannot create the link
    }
    await expect(
      confineAgyImagePath(join(dir, 'link.png'), CONV, { home, platform }),
    ).rejects.toThrow(/outside/)
  })

  it('end to end through the real fs: finds an image by scanning the folder', async () => {
    const started = Date.now()
    utimesSync(join(dir, 'ok.png'), new Date(started), new Date(started))
    const blob = await generateImageWithAgy(
      { apiKey: '', imageModel: '', analysisModel: '' },
      { prompt: 'x' },
      undefined,
      { run: async () => ({ text: 'no path given', conversationId: CONV }), home, platform },
    )
    expect(blob.mime).toBe('image/png')
    expect(blob.name).toBe('ok.png')
  })
})
