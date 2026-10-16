/**
 * The main process' mail-merge write authorization, exercised against a real
 * filesystem.
 *
 * The point of these tests is ordering: every rejection must happen *before* a
 * file is created. A check that runs after `writeMailMergeOutput` can report an
 * escape but cannot undo it, so each case here asserts both the decision and the
 * absence of any new file on disk.
 *
 * `runWrite` mirrors the production handler's sequence exactly — authorize,
 * re-check the grant after the await, then write — so a passing test means the
 * real path is safe, not just a helper.
 */
import { mkdtemp, readdir, readFile, writeFile, symlink, mkdir } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  base64ByteLength,
  decodeMailMergePayload,
  decideMailMergeWrite,
  isMailMergeOutputName,
  parseOverwritePolicy,
  MAX_MAIL_MERGE_PAYLOAD_BYTES,
  type MailMergeGrant,
} from '../src/shared/mail-merge-ipc'
import { writeMailMergeOutput } from '../src/shared/mail-merge-write'
import { containedTarget, posixRules } from '../src/shared/output-containment'

const freshDir = () => mkdtemp(join(tmpdir(), 'genoffice-mm-auth-'))
const listing = async (dir: string) => (await readdir(dir)).sort()
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

/** The containment check the main process uses for a grant. */
const contained = (dir: string, path: string) =>
  containedTarget(dir, path, posixRules, existsSync, realpathSync)

/** Exactly what `docs:write-mail-merge-file` does. */
async function runWrite(
  grant: MailMergeGrant | undefined,
  tornDown: boolean,
  dir: unknown,
  name: unknown,
  base64: unknown,
  overwrite: unknown,
) {
  const decision = decideMailMergeWrite(grant, dir, name, base64, overwrite, contained)
  if (!decision.ok) return decision
  // the request crossed an await; a tab closed in that window must not write
  if (tornDown || grant?.dir !== decision.dir) {
    return { ok: false, error: 'output directory is no longer authorized' }
  }
  try {
    const outcome = await writeMailMergeOutput(
      decision.dir,
      decision.name,
      Buffer.from(String(base64), 'base64'),
      decision.policy,
      decision.allocated,
      decision.resolvePath,
    )
    if (outcome.skipped) return { ok: false, skipped: true, path: outcome.path, name: outcome.name }
    return { ok: true, path: outcome.path, name: outcome.name }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

describe('overwrite policy parsing', () => {
  it('accepts the three real policies', () => {
    expect(parseOverwritePolicy('skip')).toBe('skip')
    expect(parseOverwritePolicy('rename')).toBe('rename')
    expect(parseOverwritePolicy('overwrite')).toBe('overwrite')
  })

  it('refuses anything else instead of defaulting to the destructive one', () => {
    expect(parseOverwritePolicy(undefined)).toBeNull()
    expect(parseOverwritePolicy(null)).toBeNull()
    expect(parseOverwritePolicy('')).toBeNull()
    expect(parseOverwritePolicy('Skip')).toBeNull()
    expect(parseOverwritePolicy('delete')).toBeNull()
    expect(parseOverwritePolicy(0)).toBeNull()
    expect(parseOverwritePolicy(true)).toBeNull()
    expect(parseOverwritePolicy({ policy: 'overwrite' })).toBeNull()
  })
})

describe('payload validation', () => {
  /**
   * `Buffer.from(text, 'base64')` is forgiving in ways a size check cannot see:
   * it ignores characters outside the alphabet, accepts padding in the middle,
   * and drops the unused bits of a non-canonical last group. "A" decodes to one
   * byte, "AAAA=" to three, "A===" to one. The writer's limit and the bytes it
   * stores have to describe the same buffer, so the payload is decoded first and
   * anything that does not round-trip is refused.
   */
  it('refuses a payload that does not decode to what it claims', () => {
    expect(decodeMailMergePayload('A')).toBeNull()
    expect(decodeMailMergePayload('AAAA=')).toBeNull()
    expect(decodeMailMergePayload('A===')).toBeNull()
    expect(decodeMailMergePayload('ABCD=')).toBeNull()
    expect(decodeMailMergePayload('AA=A')).toBeNull()
    expect(decodeMailMergePayload('')).toBeNull()
    expect(decodeMailMergePayload('not base64!!!')).toBeNull()
    expect(decodeMailMergePayload('A')).toBeNull()
    // the character-count estimate would have said 1 byte for "A" and 3 for "AAAA="
    expect(base64ByteLength('A')).toBe(-1)
    expect(base64ByteLength('AAAA=')).toBe(-1)
    expect(base64ByteLength('A===')).toBe(-1)
  })

  it('accepts canonical base64 and measures the decoded buffer', () => {
    expect(base64ByteLength(b64('hello'))).toBe(5)
    expect(decodeMailMergePayload(b64('hello'))?.length).toBe(5)
    expect(decodeMailMergePayload('AA==')?.length).toBe(1)
    // "AB==" carries bits in the last group that no byte can hold: Node decodes
    // it to "A==", so the sender did not send what the writer would store
    expect(decodeMailMergePayload('AB==')).toBeNull()
    expect(base64ByteLength('AB==')).toBe(-1)
    expect(decodeMailMergePayload('AAAA')?.length).toBe(3)
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength('a'.repeat(MAX_MAIL_MERGE_PAYLOAD_BYTES * 2))).toBeGreaterThan(
      MAX_MAIL_MERGE_PAYLOAD_BYTES,
    )
  })

  it('only accepts the two merge output types', () => {
    expect(isMailMergeOutputName('Huy.docx')).toBe(true)
    expect(isMailMergeOutputName('Huy.pdf')).toBe(true)
    expect(isMailMergeOutputName('Huy.PDF')).toBe(true)
    expect(isMailMergeOutputName('Huy.xlsx')).toBe(false)
    expect(isMailMergeOutputName('Huy')).toBe(false)
    expect(isMailMergeOutputName('Huy.docx.evil')).toBe(false)
    expect(isMailMergeOutputName('../x.docx')).toBe(true) // the path check is separate
  })
})

describe('authorization happens before anything is written', () => {
  it('writes a normal destination and reports the real path', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, 'Huy.docx', b64('first'), 'overwrite')
    expect(result.ok).toBe(true)
    expect(await listing(dir)).toEqual(['Huy.docx'])
    expect(await readFile(join(dir, 'Huy.docx'), 'utf8')).toBe('first')
  })

  it('creates nothing outside the grant for a traversal name', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, '../../escaped.docx', b64('evil'), 'overwrite')
    // the name is sanitized into the folder rather than allowed to climb out of it
    expect(result.ok).toBe(true)
    expect(await listing(dir)).toEqual(['_.._escaped.docx'])
    expect(existsSync(join(dir, '..', 'escaped.docx'))).toBe(false)
  })

  it('refuses a name that resolves through a symlink out of the grant', async () => {
    const base = await mkdtemp(join(tmpdir(), 'genoffice-mm-escape-'))
    const grant = join(base, 'out')
    const evil = join(base, 'evil')
    await mkdir(grant)
    await mkdir(evil)
    // the destination the renderer asks for already exists — as a symlink to
    // somewhere the user never authorized
    await symlink(evil, join(grant, 'Huy.docx'))
    const result = await runWrite(
      { dir: grant, allocated: new Set<string>() },
      false,
      grant,
      'Huy.docx',
      b64('evil'),
      'overwrite',
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the chosen directory')
    expect(await listing(evil)).toEqual([])
    expect(await listing(grant)).toEqual(['Huy.docx'])
  })

  it('creates nothing when the renderer sends a directory it was not granted', async () => {
    const dir = await freshDir()
    const other = await mkdtemp(join(tmpdir(), 'genoffice-mm-other-'))
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, other, 'Huy.docx', b64('evil'), 'overwrite')
    expect(result.ok).toBe(false)
    expect(await listing(other)).toEqual([])
    expect(await listing(dir)).toEqual([])
  })

  it('refuses a grant that no longer exists (renderer torn down)', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, true, dir, 'Huy.docx', b64('evil'), 'overwrite')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no longer authorized')
    expect(await listing(dir)).toEqual([])
  })

  it('refuses an unknown overwrite policy without touching the folder', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.docx'), 'the user file')
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, 'Huy.docx', b64('evil'), undefined)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('overwrite policy')
    expect(await readFile(join(dir, 'Huy.docx'), 'utf8')).toBe('the user file')
    expect(await listing(dir)).toEqual(['Huy.docx'])
  })

  it('refuses an unsupported extension', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, 'Huy.exe', b64('payload'), 'overwrite')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('.docx or .pdf')
    expect(await listing(dir)).toEqual([])
  })

  it('refuses an oversized payload before turning it into bytes', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const huge = 'A'.repeat(MAX_MAIL_MERGE_PAYLOAD_BYTES * 2)
    const result = await runWrite(grant, false, dir, 'Huy.docx', huge, 'overwrite')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('larger than')
    expect(await listing(dir)).toEqual([])
  })

  it('refuses malformed base64', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, 'Huy.docx', '!!!not base64!!!', 'overwrite')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('base64')
    expect(await listing(dir)).toEqual([])
  })

  it('refuses an empty file name', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, '   ', b64('x'), 'overwrite')
    expect(result.ok).toBe(false)
    expect(await listing(dir)).toEqual([])
  })

  it('turns a symlink-shaped name into a plain file inside the grant', async () => {
    const dir = await freshDir()
    const elsewhere = await mkdtemp(join(tmpdir(), 'genoffice-mm-elsewhere-'))
    await symlink(elsewhere, join(dir, 'link'))
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, 'link/Huy.docx', b64('evil'), 'overwrite')
    expect(result.ok).toBe(true)
    expect(await listing(dir)).toEqual(['link', 'link_Huy.docx'])
    expect(await listing(elsewhere)).toEqual([])
  })

  it('accepts an authorized directory that is itself a symlink', async () => {
    const base = await mkdtemp(join(tmpdir(), 'genoffice-mm-symlink-root-'))
    const real = join(base, 'real')
    const link = join(base, 'merge')
    await mkdir(real)
    await symlink(real, link)
    const grant = { dir: link, allocated: new Set<string>() }
    const result = await runWrite(grant, false, link, 'Huy.docx', b64('real'), 'overwrite')
    expect(result.ok).toBe(true)
    expect(await listing(real)).toEqual(['Huy.docx'])
    expect(await readFile(join(real, 'Huy.docx'), 'utf8')).toBe('real')
  })

  it('refuses a grant directory that does not exist', async () => {
    const base = await mkdtemp(join(tmpdir(), 'genoffice-mm-missing-'))
    const grant = { dir: join(base, 'never-created'), allocated: new Set<string>() }
    const result = await runWrite(
      grant,
      false,
      join(base, 'never-created'),
      'Huy.docx',
      b64('x'),
      'overwrite',
    )
    expect(result.ok).toBe(false)
    expect(await listing(base)).toEqual([])
  })

  it('sanitizes a path-shaped name instead of creating a subdirectory', async () => {
    const dir = await freshDir()
    const grant = { dir, allocated: new Set<string>() }
    const result = await runWrite(grant, false, dir, 'sub/../Huy.docx', b64('x'), 'overwrite')
    expect(result.ok).toBe(true)
    expect(await listing(dir)).toEqual(['sub_.._Huy.docx'])
  })
})

describe('the writer re-checks every candidate name it produces', () => {
  it('asks the resolver before opening a file, and creates nothing when it refuses', async () => {
    const dir = await freshDir()
    const asked: string[] = []
    const resolver = (candidate: string) => {
      asked.push(candidate)
      return null
    }
    const error = await writeMailMergeOutput(
      dir,
      'Huy.docx',
      Buffer.from('payload'),
      'overwrite',
      new Set<string>(),
      resolver,
    ).catch((err) => err)
    expect(error).toBeInstanceOf(Error)
    expect(asked).toEqual(['Huy.docx'])
    expect(await listing(dir)).toEqual([])
  })

  it('refuses a collision candidate the resolver rejects, and writes nothing', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'Huy.docx'), 'someone else')
    const asked: string[] = []
    const resolver = (candidate: string) => {
      asked.push(candidate)
      return candidate === 'Huy (2).docx' ? null : join(dir, candidate)
    }
    const error = await writeMailMergeOutput(
      dir,
      'Huy.docx',
      Buffer.from('mine'),
      'rename',
      new Set<string>(),
      resolver,
    ).catch((err) => err)
    expect(error).toBeInstanceOf(Error)
    expect(asked).toEqual(['Huy (2).docx'])
    expect(await listing(dir)).toEqual(['Huy.docx'])
    expect(await readFile(join(dir, 'Huy.docx'), 'utf8')).toBe('someone else')
  })
})
