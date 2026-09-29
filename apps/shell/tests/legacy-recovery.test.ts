import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveLegacyDoc,
  linkedLegacyDocCopy,
  listLegacyRecovery,
  rememberLegacyDocCopy,
  restoreLegacyDoc,
} from '../src/main/legacy-recovery'

const roots: string[] = []
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-legacy-recovery-'))
  roots.push(root)
  const source = join(root, 'letter.doc')
  const target = join(root, 'letter.docx')
  const userData = join(root, 'user-data')
  const original = Buffer.from('legacy original')
  await writeFile(source, original)
  await writeFile(target, Buffer.from('converted document'))
  return { root, source, target, userData, original }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('legacy document recovery', () => {
  it('archives beside the document and restores without touching the converted copy', async () => {
    const { root, source, target, userData, original } = await fixture()
    const entry = await archiveLegacyDoc(source, target, userData, hash(original), 1_000)
    expect(existsSync(source)).toBe(false)
    expect(existsSync(join(root, '.genoffice', 'originals', `${entry.id}.doc`))).toBe(true)
    expect(await listLegacyRecovery(userData, 2_000)).toMatchObject([{ sourcePath: source }])

    await expect(restoreLegacyDoc(userData, entry.id)).resolves.toBe(source)
    expect(await readFile(source)).toEqual(original)
    expect(await readFile(target, 'utf8')).toBe('converted document')
    expect(existsSync(join(root, '.genoffice'))).toBe(false)
  })

  it('never overwrites another file at the original path', async () => {
    const { source, target, userData, original } = await fixture()
    const entry = await archiveLegacyDoc(source, target, userData, hash(original))
    await writeFile(source, 'new document')
    await expect(restoreLegacyDoc(userData, entry.id)).rejects.toThrow()
    expect(await readFile(source, 'utf8')).toBe('new document')
    expect(await listLegacyRecovery(userData)).toHaveLength(1)
  })

  it('retains the original until day 30 even if the converted file was moved', async () => {
    const { root, source, target, userData, original } = await fixture()
    const now = Date.now()
    await archiveLegacyDoc(source, target, userData, hash(original), now)
    await rm(target)
    expect(await listLegacyRecovery(userData, now + 29 * 86400000)).toHaveLength(1)
    expect(await listLegacyRecovery(userData, now + 31 * 86400000)).toHaveLength(0)
    expect(existsSync(join(root, '.genoffice'))).toBe(false)
  })

  it('keeps the source when it changes during conversion', async () => {
    const { source, target, userData, original } = await fixture()
    await writeFile(source, 'newer original')
    await expect(archiveLegacyDoc(source, target, userData, hash(original))).rejects.toThrow(
      'changed during conversion',
    )
    expect(await readFile(source, 'utf8')).toBe('newer original')
    expect(await listLegacyRecovery(userData)).toHaveLength(0)
  })

  it('reuses a text-only copy until the original changes', async () => {
    const { source, target, userData, original } = await fixture()
    await rememberLegacyDocCopy(source, target, hash(original), userData)
    expect(await linkedLegacyDocCopy(source, userData)).toBe(target)
    await writeFile(source, 'edited original')
    expect(await linkedLegacyDocCopy(source, userData)).toBeNull()
  })

  it('keeps both recovery entries when two documents convert together', async () => {
    const { root, source, target, userData, original } = await fixture()
    const secondSource = join(root, 'second.doc')
    const secondTarget = join(root, 'second.docx')
    await writeFile(secondSource, original)
    await writeFile(secondTarget, 'second converted document')
    await Promise.all([
      archiveLegacyDoc(source, target, userData, hash(original)),
      archiveLegacyDoc(secondSource, secondTarget, userData, hash(original)),
    ])
    expect(await listLegacyRecovery(userData)).toHaveLength(2)
  })
})
