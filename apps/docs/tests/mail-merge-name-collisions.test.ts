/**
 * File names on a case-insensitive filesystem.
 *
 * On Windows `notes.docx` and `NOTES.docx` are the same file. Two recipients
 * whose names differ only in case used to both be handed the "free" name, and
 * with policy=overwrite the second one erased the first.
 *
 * These tests exercise the writer's collision logic with the Windows folding
 * rule passed explicitly. They are semantic tests of the rule, not a claim that
 * the code was executed on a Windows machine.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMailMergeOutput } from '../src/shared/mail-merge-write'
import { resolveSafeFileName } from '../src/shared/mail-merge-names'

describe('case-insensitive name collisions', () => {
  it('renames a second recipient whose name differs only in case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-case-'))
    const allocated = new Set<string>()
    const first = await writeMailMergeOutput(
      dir,
      'Notes.docx',
      Buffer.from('a'),
      'overwrite',
      allocated,
      (candidate) => join(dir, candidate),
      (handle, data) => handle.write(data).then(() => undefined),
      () => false,
      true,
    )
    const second = await writeMailMergeOutput(
      dir,
      'NOTES.docx',
      Buffer.from('b'),
      'overwrite',
      allocated,
      (candidate) => join(dir, candidate),
      (handle, data) => handle.write(data).then(() => undefined),
      () => false,
      true,
    )
    expect(first.name).toBe('Notes.docx')
    expect(second.name).not.toBe(first.name)
    expect(second.name.toLowerCase()).not.toBe(first.name.toLowerCase())
    expect(second.skipped).toBe(false)
    expect(readdirSync(dir).length).toBe(2)
  })

  it('does not fold case on a case-sensitive filesystem', () => {
    const allocated = new Set<string>()
    const decision = resolveSafeFileName(
      'NOTES.docx',
      'overwrite',
      (candidate) => candidate.toLowerCase() === 'notes.docx',
      allocated,
      (candidate) => candidate,
    )
    expect(decision.name).toBe('NOTES.docx')
    expect(decision.skipped).toBe(false)
  })

  it('treats a case-matching pre-existing file as pre-existing under skip', () => {
    const decision = resolveSafeFileName(
      'Notes.docx',
      'skip',
      (candidate) => candidate.toLowerCase() === 'notes.docx',
      new Set<string>(),
      (candidate) => candidate.toLowerCase(),
    )
    expect(decision.skipped).toBe(true)
    expect(decision.name).toBe('Notes.docx')
  })
})
